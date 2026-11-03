import { randomBytes } from "node:crypto";
import { z } from "zod";

import type { CanvasCourseContext, CanvasCourseOptions, CanvasCourseSource } from "./courses.js";
import {
  CANVAS_ORIGIN,
  canvasAssignmentWireSchema,
  canvasCalendarWireSchema,
  canvasEnrollmentWireSchema,
  canvasPlannerWireSchema,
  canvasSubmissionWireSchema,
  type CanvasRead,
} from "./endpoints.js";
import { CanvasConnectionError } from "./errors.js";
import type { CanvasConnection } from "./index.js";
import { createCanvasTransport, type CanvasSourceResult } from "./transport.js";

const id = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .max(128);
const date = z.iso.datetime({ offset: true }).or(z.iso.date());
function validZone(value: string): boolean {
  try {
    if (/^[+-]/u.test(value)) return false;
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
const inputSchema = z.strictObject({
  start: date,
  end: date,
  timeZone: z.string().max(128).refine(validZone).optional(),
  courseIds: z.array(id).min(1).max(100).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32}$/u)
    .optional(),
  fresh: z.boolean().optional(),
});
export interface CanvasAgendaInput {
  start: string;
  end: string;
  timeZone?: string | undefined;
  courseIds?: string[] | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  fresh?: boolean | undefined;
}
export interface CanvasAgendaEvidence {
  source: "planner" | "calendar" | "missingSubmissions" | "assignment";
  id: string;
  date: string | null;
  completed: boolean | null;
  dismissed: boolean | null;
}
export interface CanvasAgendaItem {
  key: string;
  kind: "assignment" | "event" | "note";
  courseId: string | null;
  assignmentId: string | null;
  title: string;
  htmlUrl: string | null;
  dueAt: string | null;
  lockAt: string | null;
  unlockAt: string | null;
  submissionTypes: string[] | null;
  startAt: string | null;
  endAt: string | null;
  allDay: boolean;
  allDayDate: string | null;
  submission: {
    workflowState: string;
    attempt: number | null;
    submissionType: string | null;
    gradeMatchesCurrentSubmission: boolean | null;
    submittedAt: string | null;
    missing: boolean | null;
    late: boolean | null;
    excused: boolean | null;
  } | null;
  overdue: boolean | null;
  evidence: CanvasAgendaEvidence[];
}
export interface CanvasAgendaResult {
  items: CanvasAgendaItem[];
  sources: CanvasCourseSource[];
  coverage: "complete" | "partial";
  nothingDue: boolean | null;
  effectiveTimeZone: string;
  timeZoneSource: "requested" | "configured";
  continuation?: string;
}
export interface CanvasAgendaWorkflows {
  get(input: CanvasAgendaInput, context: CanvasCourseContext): Promise<CanvasAgendaResult>;
}
interface State {
  key: string;
  generation: string;
  expires: number;
  next?: string | undefined;
  sources: CanvasCourseSource[];
  rows: unknown[][];
  scanned: boolean;
  items: CanvasAgendaItem[];
  hydrated: number;
  emitted: number;
  incomplete: boolean;
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
function localDate(value: string, zone: string): string {
  if (value.length === 10) return value;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
function boundary(value: string, zone: string): number {
  if (value.length !== 10) return Date.parse(value);
  const target = Date.parse(`${value}T00:00:00Z`);
  let epoch = target;
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(
      format.formatToParts(new Date(epoch)).map((part) => [part.type, part.value]),
    );
    const rendered = Date.parse(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
    );
    const correction = target - rendered;
    if (!correction) break;
    epoch += correction;
  }
  return epoch;
}
function emptyItem(
  key: string,
  kind: CanvasAgendaItem["kind"],
  courseId: string | null,
): CanvasAgendaItem {
  return {
    key,
    kind,
    courseId,
    assignmentId: null,
    title: "",
    htmlUrl: null,
    dueAt: null,
    lockAt: null,
    unlockAt: null,
    submissionTypes: null,
    startAt: null,
    endAt: null,
    allDay: false,
    allDayDate: null,
    submission: null,
    overdue: null,
    evidence: [],
  };
}

export function createCanvasAgendaWorkflows(
  connection: CanvasConnection,
  options: CanvasCourseOptions,
): CanvasAgendaWorkflows {
  const fallback = options.timeZone ?? "America/Phoenix";
  if (!validZone(fallback)) throw new Error("Invalid Canvas fallback timezone.");
  const transport = options.transport ?? createCanvasTransport(connection);
  const cursors = new Map<string, State>();
  return {
    get: async (input, context) => {
      const query = inputSchema.parse(input);
      const zone = query.timeZone ?? fallback;
      const start = boundary(query.start, zone);
      const end = boundary(query.end, zone);
      if (!(start < end) || Date.parse(query.end) - Date.parse(query.start) > 93 * 86_400_000)
        throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
      if (query.cursor && query.fresh) throw new CanvasConnectionError("CANVAS_INVALID_CURSOR");
      const filters = query.courseIds ? [...new Set(query.courseIds)].sort() : undefined;
      const key = JSON.stringify([
        context.caller,
        query.start,
        query.end,
        zone,
        filters,
        query.limit,
      ]);
      return transport.withSession(
        async (scoped, session) => {
          const now = Date.now();
          for (const [token, state] of cursors)
            if (state.expires <= now || state.generation !== session.generation)
              cursors.delete(token);
          const saved = query.cursor ? cursors.get(query.cursor) : undefined;
          if (query.cursor && (!saved || saved.key !== key))
            throw new CanvasConnectionError("CANVAS_INVALID_CURSOR");
          const state: State = saved
            ? structuredClone(saved)
            : {
                key,
                generation: session.generation,
                expires: now + 300_000,
                sources: [],
                rows: [[], [], [], [], []],
                scanned: false,
                items: [],
                hydrated: 0,
                emitted: 0,
                incomplete: false,
              };
          const memberships = await scoped.read(
            { endpoint: "enrollments" },
            { ...context, fresh: true, maxPages: 8 },
          );
          const enrollment = memberships.sources[0];
          if (!enrollment || enrollment.coverage !== "complete")
            throw new CanvasConnectionError(enrollment?.warnings[0] ?? "CANVAS_INVALID_RESPONSE");
          const members = new Set(
            enrollment.data.flatMap((value) => {
              const row = canvasEnrollmentWireSchema.parse(value);
              return row.user_id === options.userId &&
                row.type === "StudentEnrollment" &&
                row.enrollment_state === "active"
                ? [row.course_id]
                : [];
            }),
          );
          if (filters?.some((courseId) => !members.has(courseId)))
            throw new CanvasConnectionError("CANVAS_COURSE_FORBIDDEN");
          const allowed = (courseId: string | null) =>
            courseId === null ||
            (members.has(courseId) && (!filters || filters.includes(courseId)));
          if (state.items.some((item) => !allowed(item.courseId)))
            throw new CanvasConnectionError("CANVAS_COURSE_FORBIDDEN");
          if (!state.scanned) {
            const window = {
              startDate: new Date(start).toISOString(),
              endDate: new Date(end).toISOString(),
              ...(filters ? { courseIds: filters } : {}),
            };
            const calendarCourses = filters ?? [...members];
            if (calendarCourses.length > 100)
              throw new CanvasConnectionError("CANVAS_BUDGET_EXHAUSTED");
            const calendarWindow = {
              ...window,
              ...(calendarCourses.length ? { courseIds: calendarCourses } : {}),
            };
            const reads: CanvasRead[] = [
              { endpoint: "planner", ...window },
              { endpoint: "calendar", ...calendarWindow, type: "event" },
              { endpoint: "calendar", ...calendarWindow, type: "assignment" },
              { endpoint: "missingSubmissions", ...(filters ? { courseIds: filters } : {}) },
              ...(!filters && calendarCourses.length
                ? [
                    {
                      endpoint: "calendar" as const,
                      startDate: window.startDate,
                      endDate: window.endDate,
                      type: "event" as const,
                    },
                  ]
                : []),
            ];
            const scanned = await scoped.aggregate(reads, {
              ...context,
              maxPages: 4,
              ...(state.next ? { continuation: state.next } : { fresh: query.fresh ?? false }),
            });
            for (const [i, source] of scanned.sources.entries())
              state.rows[i]?.push(...source.data);
            state.sources = scanned.sources.map(metadata);
            state.next = scanned.continuation;
            state.scanned = !scanned.continuation;
            if (
              Buffer.byteLength(JSON.stringify(state.rows)) > 2_097_152 ||
              state.rows.reduce((sum, rows) => sum + rows.length, 0) > 1000
            )
              throw new CanvasConnectionError("CANVAS_BUDGET_EXHAUSTED");
            if (state.scanned) {
              const items = new Map<string, CanvasAgendaItem>();
              function getAssignment(courseId: string, assignmentId: string) {
                const assignmentKey = `assignment:${courseId}:${assignmentId}`;
                let item = items.get(assignmentKey);
                if (!item) {
                  item = emptyItem(assignmentKey, "assignment", courseId);
                  item.assignmentId = assignmentId;
                  item.htmlUrl = `${CANVAS_ORIGIN}/courses/${courseId}/assignments/${assignmentId}`;
                  items.set(assignmentKey, item);
                }
                return item;
              }
              for (const value of state.rows[0] ?? []) {
                const row = canvasPlannerWireSchema.parse(value);
                const courseId = row.course_id ?? null;
                if (!allowed(courseId)) {
                  state.incomplete = true;
                  continue;
                }
                const assignmentId =
                  row.plannable_type === "assignment"
                    ? row.plannable_id
                    : row.plannable?.assignment_id;
                const item =
                  courseId && assignmentId
                    ? getAssignment(courseId, assignmentId)
                    : emptyItem(
                        `planner:${courseId}:${row.plannable_type}:${row.plannable_id}`,
                        row.plannable_type === "planner_note" ? "note" : "event",
                        courseId,
                      );
                item.title ||= row.plannable?.title ?? "";
                item.startAt ??= row.plannable_date;
                if (item.kind === "assignment") item.dueAt ??= row.plannable_date;
                item.evidence.push({
                  source: "planner",
                  id: row.plannable_id,
                  date: row.plannable_date,
                  completed: row.planner_override?.marked_complete ?? null,
                  dismissed: row.planner_override?.dismissed ?? null,
                });
                items.set(item.key, item);
              }
              for (const sourceIndex of [1, 2, 4])
                for (const value of state.rows[sourceIndex] ?? []) {
                  const row = canvasCalendarWireSchema.parse(value);
                  const courseId =
                    row.assignment?.course_id ??
                    /^course_([1-9]\d*)$/u.exec(row.context_code ?? "")?.[1] ??
                    null;
                  if (!allowed(courseId)) {
                    state.incomplete = true;
                    continue;
                  }
                  const item =
                    sourceIndex === 2 && row.assignment && courseId
                      ? getAssignment(courseId, row.assignment.id)
                      : emptyItem(`calendar:${row.id}`, "event", courseId);
                  item.title ||= row.title;
                  item.startAt ??= row.start_at ?? null;
                  if (item.kind === "assignment")
                    item.dueAt ??= row.assignment?.due_at ?? row.start_at ?? null;
                  item.endAt ??= row.end_at ?? null;
                  item.allDay = row.all_day ?? false;
                  item.allDayDate =
                    row.all_day_date ??
                    (item.allDay && row.start_at ? localDate(row.start_at, zone) : null);
                  item.evidence.push({
                    source: "calendar",
                    id: row.id,
                    date: item.allDayDate ?? row.start_at ?? null,
                    completed: null,
                    dismissed: null,
                  });
                  items.set(item.key, item);
                }
              for (const value of state.rows[3] ?? []) {
                const row = canvasAssignmentWireSchema.parse(value);
                if (!allowed(row.course_id)) {
                  state.incomplete = true;
                  continue;
                }
                const item = getAssignment(row.course_id, row.id);
                item.title ||= row.name;
                item.dueAt = row.due_at ?? null;
                item.evidence.push({
                  source: "missingSubmissions",
                  id: row.id,
                  date: row.due_at ?? null,
                  completed: null,
                  dismissed: null,
                });
              }
              state.items = [...items.values()];
              state.rows = [];
            }
          }
          if (state.scanned) {
            while (state.hydrated < state.items.length && session.budget.remaining >= 2) {
              const item = state.items[state.hydrated++];
              if (!item || item.kind !== "assignment" || !item.courseId || !item.assignmentId)
                continue;
              const response = await scoped.read(
                {
                  endpoint: "assignment",
                  courseId: item.courseId,
                  assignmentId: item.assignmentId,
                },
                { ...context, fresh: query.fresh ?? false },
              );
              const source = response.sources[0];
              if (!source) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
              state.sources.push(metadata(source));
              if (source.coverage !== "complete") {
                state.incomplete = true;
                continue;
              }
              const row = canvasAssignmentWireSchema.parse(source.data[0]);
              if (row.course_id !== item.courseId || row.id !== item.assignmentId)
                throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
              item.title = row.name;
              item.dueAt = row.due_at ?? null;
              item.lockAt = row.lock_at ?? null;
              item.unlockAt = row.unlock_at ?? null;
              item.submissionTypes = row.submission_types ?? null;
              item.evidence.push({
                source: "assignment",
                id: row.id,
                date: row.due_at ?? null,
                completed: null,
                dismissed: null,
              });
              let submission = row.submission;
              if (submission === undefined) {
                const response = await scoped.read(
                  {
                    endpoint: "submission",
                    courseId: item.courseId,
                    assignmentId: item.assignmentId,
                  },
                  { ...context, fresh: query.fresh ?? false },
                );
                const origin = response.sources[0];
                if (!origin) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
                state.sources.push(metadata(origin));
                if (origin.coverage === "complete")
                  submission = canvasSubmissionWireSchema.parse(origin.data[0]);
                else state.incomplete = true;
              }
              if (submission) {
                if (
                  submission.assignment_id !== item.assignmentId ||
                  submission.user_id !== options.userId
                )
                  throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
                item.submission = {
                  workflowState: submission.workflow_state,
                  attempt: submission.attempt ?? null,
                  submissionType: submission.submission_type ?? null,
                  gradeMatchesCurrentSubmission:
                    submission.grade_matches_current_submission ?? null,
                  submittedAt: submission.submitted_at ?? null,
                  missing: submission.missing ?? null,
                  late: submission.late ?? null,
                  excused: submission.excused ?? null,
                };
                item.overdue =
                  submission.excused === true ||
                  submission.submitted_at ||
                  ["submitted", "pending_review", "graded"].includes(submission.workflow_state)
                    ? false
                    : submission.missing === true
                      ? true
                      : item.dueAt &&
                          row.submission_types?.some((type) =>
                            [
                              "online_upload",
                              "online_text_entry",
                              "online_url",
                              "media_recording",
                            ].includes(type),
                          )
                        ? Date.parse(item.dueAt) < now
                        : null;
              }
            }
          }
          const ready = state.scanned && state.hydrated === state.items.length;
          if (ready && state.emitted === 0) {
            state.items = state.items
              .filter((item) => {
                if (
                  item.kind === "assignment" &&
                  item.evidence.some((evidence) => evidence.source === "missingSubmissions")
                )
                  return true;
                const value =
                  item.kind === "assignment"
                    ? item.dueAt
                    : item.allDay
                      ? item.allDayDate
                      : item.startAt;
                if (value === null) return false;
                const begins = boundary(value, zone);
                if (item.kind === "event" && item.endAt)
                  return begins < end && boundary(item.endAt, zone) > start;
                return begins >= start && begins < end;
              })
              .sort(
                (a, b) =>
                  boundary(a.dueAt ?? (a.allDay ? a.allDayDate : a.startAt) ?? "9999-12-31", zone) -
                    boundary(
                      b.dueAt ?? (b.allDay ? b.allDayDate : b.startAt) ?? "9999-12-31",
                      zone,
                    ) || a.key.localeCompare(b.key),
              );
          }
          if (ready) state.hydrated = state.items.length;
          const pageCandidates = ready
            ? state.items.slice(state.emitted, state.emitted + Math.min(query.limit, 5))
            : [];
          const pageSources = state.sources.filter(
            (source, index) =>
              index < (filters || !members.size ? 4 : 5) ||
              source.coverage !== "complete" ||
              pageCandidates.some(
                (item) =>
                  item.courseId &&
                  item.assignmentId &&
                  [
                    `/api/v1/courses/${item.courseId}/assignments/${item.assignmentId}`,
                    `/api/v1/courses/${item.courseId}/assignments/${item.assignmentId}/submissions/self`,
                  ].includes(new URL(source.source).pathname),
              ),
          );
          const sources = [metadata(enrollment), ...pageSources].map((source) => ({
            ...source,
            cacheAgeMs: source.retrievedAt
              ? Math.max(source.cacheAgeMs, now - Date.parse(source.retrievedAt))
              : 0,
          }));
          const result: CanvasAgendaResult = {
            items: [],
            sources,
            coverage: "partial",
            nothingDue: null,
            effectiveTimeZone: zone,
            timeZoneSource: query.timeZone ? "requested" : "configured",
          };
          if (ready)
            for (const item of state.items.slice(
              state.emitted,
              state.emitted + Math.min(query.limit, 5),
            )) {
              result.items.push(item);
              if (Buffer.byteLength(JSON.stringify(result)) > 15 * 1024) {
                result.items.pop();
                break;
              }
            }
          if (ready && state.items.length > state.emitted && !result.items.length)
            throw new CanvasConnectionError("CANVAS_BUDGET_EXHAUSTED");
          state.emitted += result.items.length;
          if (query.cursor) cursors.delete(query.cursor);
          if (!ready || state.emitted < state.items.length) {
            const token = randomBytes(24).toString("base64url");
            if (cursors.size >= 64) cursors.delete(cursors.keys().next().value ?? "");
            cursors.set(token, state);
            result.continuation = token;
          } else if (
            !state.incomplete &&
            state.sources.every((source) => source.coverage === "complete")
          ) {
            result.coverage = "complete";
            result.nothingDue = !state.items.some(
              (item) =>
                (item.kind === "assignment" &&
                  item.submission?.excused !== true &&
                  (!item.submission ||
                    (!item.submission.submittedAt &&
                      !["submitted", "pending_review", "graded"].includes(
                        item.submission.workflowState,
                      )))) ||
                ["event", "note"].includes(item.kind),
            );
          }
          if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024)
            throw new CanvasConnectionError("CANVAS_BUDGET_EXHAUSTED");
          return result;
        },
        context.signal ? { signal: context.signal } : {},
      );
    },
  };
}
