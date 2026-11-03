import { randomBytes } from "node:crypto";
import { z } from "zod";

import { canvasCourseWireSchema, canvasEnrollmentWireSchema } from "./endpoints.js";
import { CanvasConnectionError } from "./errors.js";
import type { CanvasConnection, CanvasSession } from "./index.js";
import {
  createCanvasTransport,
  type CanvasSourceResult,
  type CanvasTransport,
} from "./transport.js";

export interface CanvasCourse {
  id: string;
  name: string | null;
  courseCode: string | null;
  workflowState: string | null;
  timeZone: string | null;
  effectiveTimeZone: string;
  timeZoneSource: "course" | "configured";
  htmlUrl: string;
  enrollmentState: "active" | "completed";
}
export type CanvasCourseSource = Omit<CanvasSourceResult, "data">;
export interface CanvasCourseListResult {
  courses: CanvasCourse[];
  sources: CanvasCourseSource[];
  continuation?: string;
}
export interface CanvasCourseResult {
  course: CanvasCourse;
  sources: CanvasCourseSource[];
}
export interface CanvasCourseContext {
  caller: string;
  signal?: AbortSignal;
}
export interface CanvasCourseListInput {
  concluded?: boolean | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  fresh?: boolean | undefined;
}
export interface CanvasCourseInput {
  courseId: string;
  concluded?: boolean | undefined;
  fresh?: boolean | undefined;
}
export interface CanvasCourseOptions {
  userId: string;
  timeZone?: string;
}
export interface CanvasCourseWorkflows {
  list(input: CanvasCourseListInput, context: CanvasCourseContext): Promise<CanvasCourseListResult>;
  get(input: CanvasCourseInput, context: CanvasCourseContext): Promise<CanvasCourseResult>;
}
const id = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .max(128);
const filters = { concluded: z.boolean().default(false), fresh: z.boolean().default(false) };
// Leave room for the MCP host's structured result and escaped text at its 64 KiB limit.
const MAX_RESULT_BYTES = 16 * 1024;
function resultBytes(result: CanvasCourseListResult | CanvasCourseResult): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}
const listInput = z.strictObject({
  ...filters,
  limit: z.number().int().min(1).max(100).default(100),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32}$/u)
    .optional(),
});
const courseInput = z.strictObject({ ...filters, courseId: id });
interface Cursor {
  key: string;
  generation: string;
  expires: number;
  pending: CanvasCourse[];
  next?: string;
  source: CanvasCourseSource;
}
function metadata(source: CanvasSourceResult): CanvasCourseSource {
  return {
    source: source.source,
    sourceLinks: source.sourceLinks,
    coverage: source.coverage,
    retrievedAt: source.retrievedAt,
    cacheAgeMs: source.cacheAgeMs,
    warnings: source.warnings,
  };
}
function validTimeZone(value: string): boolean {
  if (/^[+-]/u.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
function requireSource(result: { sources: CanvasSourceResult[] }): CanvasSourceResult {
  const source = result.sources[0];
  if (!source) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
  return source;
}
function sourceError(source: CanvasSourceResult): CanvasConnectionError {
  return new CanvasConnectionError(source.warnings[0] ?? "CANVAS_INVALID_RESPONSE");
}

export function createCanvasCourseWorkflows(
  connection: CanvasConnection,
  options: CanvasCourseOptions,
): CanvasCourseWorkflows {
  id.parse(options.userId);
  const fallbackTimeZone = options.timeZone ?? "America/Phoenix";
  if (!validTimeZone(fallbackTimeZone)) throw new Error("Invalid Canvas fallback timezone.");
  const transport = createCanvasTransport(connection);
  const cursors = new Map<string, Cursor>();

  async function memberships(
    scoped: CanvasTransport,
    context: CanvasCourseContext,
    concluded: boolean,
  ): Promise<{ states: Map<string, "active" | "completed">; source: CanvasCourseSource }> {
    const result = await scoped.read(
      { endpoint: "enrollments", concluded },
      { ...context, fresh: true, maxPages: 18 },
    );
    const source = requireSource(result);
    if (source.coverage !== "complete") throw sourceError(source);
    const states = new Map<string, "active" | "completed">();
    for (const value of source.data) {
      const enrollment = canvasEnrollmentWireSchema.parse(value);
      if (enrollment.user_id !== options.userId || enrollment.type !== "StudentEnrollment")
        continue;
      if (!enrollment.enrollment_state) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
      if (enrollment.enrollment_state === "active") states.set(enrollment.course_id, "active");
      else if (
        concluded &&
        enrollment.enrollment_state === "completed" &&
        !states.has(enrollment.course_id)
      )
        states.set(enrollment.course_id, "completed");
    }
    return { states, source: metadata(source) };
  }
  function normalize(
    value: unknown,
    states: ReadonlyMap<string, "active" | "completed">,
    concluded: boolean,
  ): CanvasCourse | undefined {
    const course = canvasCourseWireSchema.parse(value);
    const enrollmentState = states.get(course.id);
    if (!enrollmentState || (!concluded && course.workflow_state === "completed")) return undefined;
    const timeZone = course.time_zone ?? null;
    if (timeZone !== null && !validTimeZone(timeZone))
      throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
    return {
      id: course.id,
      name: course.name ?? null,
      courseCode: course.course_code ?? null,
      workflowState: course.workflow_state ?? null,
      timeZone,
      effectiveTimeZone: timeZone ?? fallbackTimeZone,
      timeZoneSource: timeZone === null ? "configured" : "course",
      htmlUrl: `https://learn.maricopa.edu/courses/${course.id}`,
      enrollmentState,
    };
  }
  function settings(context: CanvasCourseContext) {
    return context.signal === undefined ? {} : { signal: context.signal };
  }
  return {
    list: async (input, context) => {
      const query = listInput.parse(input);
      if (query.cursor && query.fresh) throw new CanvasConnectionError("CANVAS_INVALID_CURSOR");
      const key = JSON.stringify([context.caller, query.concluded, query.limit]);
      return transport.withSession(async (scoped, session: CanvasSession) => {
        const now = Date.now();
        for (const [token, state] of cursors)
          if (state.expires <= now || state.generation !== session.generation)
            cursors.delete(token);
        const state = query.cursor ? cursors.get(query.cursor) : undefined;
        if (query.cursor && (!state || state.key !== key))
          throw new CanvasConnectionError("CANVAS_INVALID_CURSOR");
        const membership = await memberships(scoped, context, query.concluded);
        let pending =
          state?.pending.flatMap((course) => {
            const enrollmentState = membership.states.get(course.id);
            return enrollmentState ? [{ ...course, enrollmentState }] : [];
          }) ?? [];
        let next = state?.next;
        let source = state
          ? {
              ...state.source,
              cacheAgeMs:
                state.source.retrievedAt === null
                  ? 0
                  : Math.max(state.source.cacheAgeMs, now - Date.parse(state.source.retrievedAt)),
            }
          : undefined;
        if (!state || (pending.length < query.limit && next)) {
          const result = await scoped.read(
            { endpoint: "courses", concluded: query.concluded },
            {
              ...context,
              fresh: query.fresh,
              maxPages: 1,
              ...(next === undefined ? {} : { continuation: next }),
            },
          );
          const raw = requireSource(result);
          if (raw.coverage === "unavailable") throw sourceError(raw);
          source = metadata(raw);
          next = result.continuation;
          pending = pending.concat(
            raw.data.flatMap((value) => {
              const course = normalize(value, membership.states, query.concluded);
              return course ? [course] : [];
            }),
          );
        }
        if (!source) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
        const courses: CanvasCourse[] = [];
        const result: CanvasCourseListResult = { courses, sources: [membership.source, source] };
        for (const course of pending.slice(0, query.limit)) {
          courses.push(course);
          if (resultBytes(result) > MAX_RESULT_BYTES - 128) {
            courses.pop();
            break;
          }
        }
        if (pending.length && !courses.length)
          throw new CanvasConnectionError("CANVAS_BUDGET_EXHAUSTED");
        pending = pending.slice(courses.length);
        if (query.cursor) cursors.delete(query.cursor);
        if (pending.length || next) {
          const token = randomBytes(24).toString("base64url");
          if (cursors.size >= 64) cursors.delete(cursors.keys().next().value ?? "");
          cursors.set(token, {
            key,
            generation: session.generation,
            expires: state?.expires ?? now + 300_000,
            pending,
            ...(next === undefined ? {} : { next }),
            source,
          });
          result.continuation = token;
          result.sources[1] = { ...source, coverage: "partial" };
        }
        if (resultBytes(result) > MAX_RESULT_BYTES)
          throw new CanvasConnectionError("CANVAS_BUDGET_EXHAUSTED");
        return result;
      }, settings(context));
    },
    get: async (input, context) => {
      const query = courseInput.parse(input);
      return transport.withSession(async (scoped) => {
        const membership = await memberships(scoped, context, query.concluded);
        if (!membership.states.has(query.courseId))
          throw new CanvasConnectionError("CANVAS_COURSE_FORBIDDEN");
        const result = await scoped.read(
          { endpoint: "course", courseId: query.courseId },
          { ...context, fresh: query.fresh },
        );
        const source = requireSource(result);
        if (source.coverage !== "complete") throw sourceError(source);
        const course = normalize(source.data[0], membership.states, query.concluded);
        if (!course || course.id !== query.courseId)
          throw new CanvasConnectionError("CANVAS_COURSE_FORBIDDEN");
        const data = { course, sources: [membership.source, metadata(source)] };
        if (resultBytes(data) > MAX_RESULT_BYTES)
          throw new CanvasConnectionError("CANVAS_BUDGET_EXHAUSTED");
        return data;
      }, settings(context));
    },
  };
}
