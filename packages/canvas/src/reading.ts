import { randomBytes } from "node:crypto";
import {
  convertHtmlDocument,
  DocumentTextError,
  type DocumentTextResult,
} from "@unimatrix/document-text";
import { z } from "zod";

import {
  createCanvasCourseWorkflows,
  type CanvasCourseContext,
  type CanvasCourseOptions,
  type CanvasCourseSource,
} from "./courses.js";
import {
  CANVAS_ORIGIN,
  canvasAnnouncementWireSchema,
  canvasCourseWireSchema,
  canvasEnrollmentWireSchema,
  canvasFileWireSchema,
  canvasModuleItemWireSchema,
  canvasModuleWireSchema,
  canvasPageWireSchema,
  type CanvasRead,
} from "./endpoints.js";
import { CanvasConnectionError } from "./errors.js";
import type { CanvasConnection, CanvasSession } from "./index.js";
import {
  createCanvasTransport,
  type CanvasSourceResult,
  type CanvasTransport,
} from "./transport.js";

const id = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .max(128);
const base = { courseId: id, concluded: z.boolean().optional(), fresh: z.boolean().optional() };
const pagination = {
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32}$/u)
    .optional(),
};
const documentContinuation = {
  documentId: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  offset: z.number().int().positive().max(2_000_000).optional(),
};
const paired = (value: { documentId?: string | undefined; offset?: number | undefined }) =>
  (value.documentId === undefined) === (value.offset === undefined);
const courseInput = z.strictObject(base);
const listInput = z.strictObject({ ...base, ...pagination });
const syllabusInput = z.strictObject({ ...base, ...documentContinuation }).refine(paired);
const pageInput = z
  .strictObject({
    ...base,
    selector: z.enum(["front_page", "id", "slug"]),
    pageId: id.optional(),
    pageSlug: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/u)
      .optional(),
    ...documentContinuation,
  })
  .refine(paired)
  .refine((value) =>
    value.selector === "front_page"
      ? value.pageId === undefined && value.pageSlug === undefined
      : value.selector === "id"
        ? value.pageId !== undefined && value.pageSlug === undefined
        : value.pageSlug !== undefined && value.pageId === undefined,
  );
const moduleItemsInput = listInput.extend({ moduleId: id });
const fileInput = courseInput.extend({ fileId: id });
const date = z.iso.datetime({ offset: true }).or(z.iso.date());
const announcementsInput = z
  .strictObject({
    start: date,
    end: date,
    courseIds: z.array(id).min(1).max(100),
    fresh: z.boolean().optional(),
    ...pagination,
    announcementId: id.optional(),
    ...documentContinuation,
  })
  .refine(paired)
  .refine((value) => value.documentId === undefined || value.announcementId !== undefined)
  .refine((value) => Date.parse(value.start) <= Date.parse(value.end));
export type CanvasReadingListInput = z.input<typeof listInput>;
export type CanvasSyllabusInput = z.input<typeof syllabusInput>;
export type CanvasPageInput = z.input<typeof pageInput>;
export type CanvasModuleItemsInput = z.input<typeof moduleItemsInput>;
export type CanvasFileInput = z.input<typeof fileInput>;
export type CanvasAnnouncementsInput = z.input<typeof announcementsInput>;
interface DocumentFields {
  document: DocumentTextResult | null;
  availability: "included" | "absent" | "unavailable" | "not_requested";
  warnings: string[];
}
function document(
  html: string | null | undefined,
  htmlUrl: string,
  query: { documentId?: string | undefined; offset?: number | undefined } = {},
  locked = false,
  requested = true,
): DocumentFields {
  if (locked)
    return {
      document: null,
      availability: "unavailable",
      warnings: ["CANVAS_RESOURCE_UNAVAILABLE"],
    };
  if (!requested) return { document: null, availability: "not_requested", warnings: [] };
  if (html === undefined)
    return { document: null, availability: "unavailable", warnings: ["CANVAS_DOCUMENT_ABSENT"] };
  if (html === null) {
    if (query.documentId) throw new CanvasConnectionError("CANVAS_INVALID_CURSOR");
    return { document: null, availability: "absent", warnings: [] };
  }
  try {
    return {
      document: convertHtmlDocument({
        html,
        baseUrl: htmlUrl,
        maxOutputCharacters: 1500,
        ...(query.documentId === undefined || query.offset === undefined
          ? {}
          : { continuation: { documentId: query.documentId, offset: query.offset } }),
      }),
      availability: "included",
      warnings: [],
    };
  } catch (error) {
    if (!(error instanceof DocumentTextError)) throw error;
    if (error.code === "invalid_continuation")
      throw new CanvasConnectionError("CANVAS_INVALID_CURSOR");
    return {
      document: null,
      availability: "unavailable",
      warnings: [`DOCUMENT_TEXT_${error.code.toUpperCase()}`],
    };
  }
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
function source(result: { sources: CanvasSourceResult[] }): CanvasSourceResult {
  const raw = result.sources[0];
  if (!raw) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
  return raw;
}
function bounded<T>(result: T): T {
  if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024)
    throw new CanvasConnectionError("CANVAS_BUDGET_EXHAUSTED");
  return result;
}
function page(
  value: unknown,
  courseId: string,
  query: { documentId?: string | undefined; offset?: number | undefined } = {},
  requested = true,
) {
  const row = canvasPageWireSchema.parse(value);
  if (!/^[A-Za-z0-9_-]+$/u.test(row.url))
    throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
  const htmlUrl = `${CANVAS_ORIGIN}/courses/${courseId}/pages/${row.url}`;
  return {
    id: row.page_id,
    courseId,
    slug: row.url,
    title: row.title,
    htmlUrl,
    frontPage: row.front_page ?? null,
    lockedForUser: row.locked_for_user ?? null,
    lockExplanation: row.lock_explanation ?? null,
    ...document(row.body, htmlUrl, query, row.locked_for_user === true, requested),
  };
}
function module(value: unknown, courseId: string) {
  const row = canvasModuleWireSchema.parse(value);
  return {
    id: row.id,
    courseId,
    name: row.name,
    position: row.position ?? null,
    prerequisiteModuleIds: row.prerequisite_module_ids ?? null,
    requireSequentialProgress: row.require_sequential_progress ?? null,
    state: row.state ?? null,
    unlockAt: row.unlock_at ?? null,
    itemsCount: row.items_count ?? null,
    htmlUrl: `${CANVAS_ORIGIN}/courses/${courseId}/modules/${row.id}`,
  };
}
function moduleItem(value: unknown, courseId: string, moduleId: string, state: string | null) {
  const row = canvasModuleItemWireSchema.parse(value);
  if (row.module_id !== moduleId) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
  const locked = state === "locked" || row.locked_for_user === true;
  return {
    id: row.id,
    courseId,
    moduleId,
    title: row.title,
    type: row.type,
    position: row.position ?? null,
    contentId: row.content_id ?? null,
    pageSlug: row.page_url ?? null,
    htmlUrl: `${CANVAS_ORIGIN}/courses/${courseId}/modules/items/${row.id}`,
    lockedForUser: row.locked_for_user ?? null,
    completionRequirement: row.completion_requirement
      ? {
          type: row.completion_requirement.type,
          minScore: row.completion_requirement.min_score ?? null,
          completed: row.completion_requirement.completed ?? null,
        }
      : null,
    availability: locked
      ? ("unavailable" as const)
      : row.locked_for_user === false ||
          state === "unlocked" ||
          state === "started" ||
          state === "completed"
        ? ("available" as const)
        : ("unknown" as const),
  };
}
function file(value: unknown, courseId: string) {
  const row = canvasFileWireSchema.parse(value);
  return {
    id: row.id,
    courseId,
    displayName: row.display_name,
    filename: row.filename ?? null,
    size: row.size ?? null,
    contentType: row["content-type"] ?? null,
    locked: row.locked ?? null,
    lockedForUser: row.locked_for_user ?? null,
    hidden: row.hidden ?? null,
    hiddenForUser: row.hidden_for_user ?? null,
    lockExplanation: row.lock_explanation ?? null,
    lockAt: row.lock_at ?? null,
    unlockAt: row.unlock_at ?? null,
    htmlUrl: `${CANVAS_ORIGIN}/courses/${courseId}/files/${row.id}`,
    availability:
      row.locked_for_user === true || row.locked === true || row.hidden_for_user === true
        ? ("unavailable" as const)
        : row.locked_for_user === false
          ? ("available" as const)
          : ("unknown" as const),
  };
}
export type CanvasReadingPage = ReturnType<typeof page>;
export type CanvasReadingModule = ReturnType<typeof module>;
export type CanvasReadingModuleItem = ReturnType<typeof moduleItem>;
export type CanvasReadingFile = ReturnType<typeof file>;
interface ListResult<T> {
  values: T[];
  sources: CanvasCourseSource[];
  continuation?: string;
}
interface Cursor {
  key: string;
  generation: string;
  expires: number;
  pending: unknown[];
  next?: string;
  source: CanvasCourseSource;
}

export function createCanvasReadingWorkflows(
  connection: CanvasConnection,
  options: CanvasCourseOptions,
) {
  const transport = options.transport ?? createCanvasTransport(connection);
  const cursors = new Map<string, Cursor>();
  async function verify(
    scoped: CanvasTransport,
    input: CanvasReadingListInput | CanvasSyllabusInput,
    context: CanvasCourseContext,
  ) {
    return createCanvasCourseWorkflows(connection, { ...options, transport: scoped }).get(
      {
        courseId: input.courseId,
        ...(input.concluded === undefined ? {} : { concluded: input.concluded }),
        ...(input.fresh === undefined ? {} : { fresh: input.fresh }),
      },
      context,
    );
  }
  async function list<T>(
    scoped: CanvasTransport,
    session: CanvasSession,
    read: CanvasRead,
    query: { limit: number; cursor?: string | undefined; fresh?: boolean | undefined },
    context: CanvasCourseContext,
    sources: CanvasCourseSource[],
    normalize: (value: unknown) => T | undefined,
    filters: unknown,
    embedded?: CanvasSourceResult,
  ): Promise<ListResult<T>> {
    if (query.cursor && query.fresh) throw new CanvasConnectionError("CANVAS_INVALID_CURSOR");
    const now = Date.now();
    for (const [token, state] of cursors)
      if (state.expires <= now || state.generation !== session.generation) cursors.delete(token);
    const key = JSON.stringify([context.caller, read, query.limit, filters]);
    const state = query.cursor ? cursors.get(query.cursor) : undefined;
    if (query.cursor && (!state || state.key !== key))
      throw new CanvasConnectionError("CANVAS_INVALID_CURSOR");
    let pending = state?.pending ?? [];
    let next = state?.next;
    let origin = state?.source;
    if (!state || (!pending.length && next)) {
      const response =
        embedded && !state
          ? { sources: [embedded] }
          : await scoped.read(read, {
              ...context,
              maxPages: 1,
              ...(query.fresh === undefined ? {} : { fresh: query.fresh }),
              ...(next === undefined ? {} : { continuation: next }),
            });
      const raw = source(response);
      pending = pending.concat(raw.data);
      next = "continuation" in response ? response.continuation : undefined;
      origin = metadata(raw);
    }
    if (!origin) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
    const values: T[] = [];
    const result: ListResult<T> = {
      values,
      sources: [
        ...sources,
        {
          ...origin,
          cacheAgeMs:
            origin.retrievedAt === null
              ? 0
              : Math.max(origin.cacheAgeMs, now - Date.parse(origin.retrievedAt)),
        },
      ],
    };
    let consumed = 0;
    for (const value of pending) {
      const normalized = normalize(value);
      if (normalized !== undefined) {
        values.push(normalized);
        if (Buffer.byteLength(JSON.stringify(result)) > 14 * 1024) {
          values.pop();
          if (!values.length) throw new CanvasConnectionError("CANVAS_BUDGET_EXHAUSTED");
          break;
        }
      }
      consumed++;
      if (values.length >= query.limit) break;
    }
    pending = pending.slice(consumed);
    if (query.cursor) cursors.delete(query.cursor);
    if (pending.length || next) {
      const token = randomBytes(24).toString("base64url");
      if (cursors.size >= 64) cursors.delete(cursors.keys().next().value ?? "");
      cursors.set(token, {
        key,
        generation: session.generation,
        expires: state?.expires ?? now + 300_000,
        pending,
        source: origin,
        ...(next === undefined ? {} : { next }),
      });
      result.continuation = token;
      result.sources[result.sources.length - 1] = { ...origin, coverage: "partial" };
    }
    return bounded(result);
  }
  function settings(context: CanvasCourseContext) {
    return context.signal === undefined ? {} : { signal: context.signal };
  }
  async function read(
    scoped: CanvasTransport,
    endpoint: CanvasRead,
    context: CanvasCourseContext,
    fresh?: boolean,
  ) {
    const result = source(
      await scoped.read(endpoint, {
        ...context,
        maxPages: 18,
        ...(fresh === undefined ? {} : { fresh }),
      }),
    );
    if (result.coverage !== "complete")
      throw new CanvasConnectionError(result.warnings[0] ?? "CANVAS_BUDGET_EXHAUSTED");
    return result;
  }
  return {
    syllabus: async (input: CanvasSyllabusInput, context: CanvasCourseContext) => {
      const query = syllabusInput.parse(input);
      return transport.withSession(async (scoped) => {
        const course = await verify(scoped, query, context);
        const raw = await read(
          scoped,
          { endpoint: "syllabus", courseId: query.courseId },
          context,
          query.fresh,
        );
        const row = canvasCourseWireSchema.parse(raw.data[0]);
        if (row.id !== query.courseId) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
        const htmlUrl = `${CANVAS_ORIGIN}/courses/${query.courseId}/assignments/syllabus`;
        return bounded({
          syllabus: {
            courseId: query.courseId,
            htmlUrl,
            ...document(row.syllabus_body, htmlUrl, query),
          },
          sources: [...course.sources, metadata(raw)],
        });
      }, settings(context));
    },
    announcements: async (input: CanvasAnnouncementsInput, context: CanvasCourseContext) => {
      const query = announcementsInput.parse(input);
      return transport.withSession(async (scoped, session) => {
        const enrollment = await read(scoped, { endpoint: "enrollments" }, context, true);
        const allowed = new Set(
          enrollment.data
            .map((value) => canvasEnrollmentWireSchema.parse(value))
            .filter(
              (row) =>
                row.user_id === options.userId &&
                row.type === "StudentEnrollment" &&
                row.enrollment_state === "active",
            )
            .map((row) => row.course_id),
        );
        if (query.courseIds.some((courseId) => !allowed.has(courseId)))
          throw new CanvasConnectionError("CANVAS_COURSE_FORBIDDEN");
        const sources = [metadata(enrollment)];
        const result = await list(
          scoped,
          session,
          {
            endpoint: "announcements",
            startDate: query.start,
            endDate: query.end,
            courseIds: query.courseIds,
          },
          query,
          context,
          sources,
          (value) => {
            const row = canvasAnnouncementWireSchema.parse(value);
            if (query.announcementId && row.id !== query.announcementId) return undefined;
            const courseId = /^course_([1-9]\d*)$/u.exec(row.context_code ?? "")?.[1];
            if (!courseId || !query.courseIds.includes(courseId))
              throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
            const htmlUrl = `${CANVAS_ORIGIN}/courses/${courseId}/discussion_topics/${row.id}`;
            return {
              id: row.id,
              courseId,
              title: row.title,
              htmlUrl,
              postedAt: row.posted_at ?? null,
              ...document(row.message, htmlUrl, query, row.locked_for_user === true),
            };
          },
          [query.announcementId, query.documentId, query.offset],
        );
        const { values, ...rest } = result;
        if (
          query.announcementId &&
          !values.length &&
          !rest.continuation &&
          rest.sources.at(-1)?.coverage === "complete"
        )
          throw new CanvasConnectionError("CANVAS_RESOURCE_UNAVAILABLE");
        return { announcements: values, ...rest };
      }, settings(context));
    },
    pages: async (input: CanvasReadingListInput, context: CanvasCourseContext) => {
      const query = listInput.parse(input);
      return transport.withSession(async (scoped, session) => {
        const course = await verify(scoped, query, context);
        const { values, ...rest } = await list(
          scoped,
          session,
          { endpoint: "pages", courseId: query.courseId },
          query,
          context,
          course.sources,
          (value) => page(value, query.courseId, {}, false),
          query.concluded ?? false,
        );
        return { pages: values, ...rest };
      }, settings(context));
    },
    page: async (input: CanvasPageInput, context: CanvasCourseContext) => {
      const query = pageInput.parse(input);
      return transport.withSession(async (scoped) => {
        const course = await verify(scoped, query, context);
        const selector: Extract<CanvasRead, { endpoint: "page" }>["selector"] =
          query.selector === "front_page"
            ? { kind: "frontPage" }
            : query.selector === "id"
              ? { kind: "id", pageId: query.pageId! }
              : { kind: "slug", slug: query.pageSlug! };
        const raw = await read(
          scoped,
          { endpoint: "page", courseId: query.courseId, selector },
          context,
          query.fresh,
        );
        const normalized = page(raw.data[0], query.courseId, query);
        if (
          (query.selector === "id" && normalized.id !== query.pageId) ||
          (query.selector === "slug" && normalized.slug !== query.pageSlug) ||
          (query.selector === "front_page" && normalized.frontPage !== true)
        )
          throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
        return bounded({ page: normalized, sources: [...course.sources, metadata(raw)] });
      }, settings(context));
    },
    modules: async (input: CanvasReadingListInput, context: CanvasCourseContext) => {
      const query = listInput.parse(input);
      return transport.withSession(async (scoped, session) => {
        const course = await verify(scoped, query, context);
        const { values, ...rest } = await list(
          scoped,
          session,
          { endpoint: "modules", courseId: query.courseId },
          query,
          context,
          course.sources,
          (value) => module(value, query.courseId),
          query.concluded ?? false,
        );
        return { modules: values, ...rest };
      }, settings(context));
    },
    moduleItems: async (input: CanvasModuleItemsInput, context: CanvasCourseContext) => {
      const query = moduleItemsInput.parse(input);
      return transport.withSession(async (scoped, session) => {
        const course = await verify(scoped, query, context);
        const raw = await read(
          scoped,
          { endpoint: "module", courseId: query.courseId, moduleId: query.moduleId },
          context,
          true,
        );
        const wire = canvasModuleWireSchema.parse(raw.data[0]);
        if (wire.id !== query.moduleId) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
        const normalized = module(wire, query.courseId);
        const embedded =
          wire.items !== undefined &&
          wire.items_count !== undefined &&
          wire.items.length === wire.items_count
            ? { ...raw, data: wire.items }
            : undefined;
        const { values, ...rest } = await list(
          scoped,
          session,
          { endpoint: "moduleItems", courseId: query.courseId, moduleId: query.moduleId },
          query,
          context,
          [...course.sources, metadata(raw)],
          (value) => moduleItem(value, query.courseId, query.moduleId, normalized.state),
          query.concluded ?? false,
          embedded,
        );
        return bounded({ module: normalized, items: values, ...rest });
      }, settings(context));
    },
    files: async (input: CanvasReadingListInput, context: CanvasCourseContext) => {
      const query = listInput.parse(input);
      return transport.withSession(async (scoped, session) => {
        const course = await verify(scoped, query, context);
        const { values, ...rest } = await list(
          scoped,
          session,
          { endpoint: "files", courseId: query.courseId },
          query,
          context,
          course.sources,
          (value) => file(value, query.courseId),
          query.concluded ?? false,
        );
        return { files: values, ...rest };
      }, settings(context));
    },
    file: async (input: CanvasFileInput, context: CanvasCourseContext) => {
      const query = fileInput.parse(input);
      return transport.withSession(async (scoped) => {
        const course = await verify(scoped, query, context);
        const raw = await read(
          scoped,
          { endpoint: "file", courseId: query.courseId, fileId: query.fileId },
          context,
          query.fresh,
        );
        const normalized = file(raw.data[0], query.courseId);
        if (normalized.id !== query.fileId)
          throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
        return bounded({ file: normalized, sources: [...course.sources, metadata(raw)] });
      }, settings(context));
    },
  };
}
export type CanvasReadingWorkflows = ReturnType<typeof createCanvasReadingWorkflows>;
