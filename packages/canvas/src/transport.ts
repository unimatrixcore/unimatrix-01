import { createHash, randomBytes } from "node:crypto";
import { buildEndpoint, type CanvasRead } from "./endpoints.js";
import { CanvasConnectionError, type CanvasConnectionErrorCode } from "./errors.js";
import type { CanvasConnection, CanvasOperationOptions, CanvasSession } from "./index.js";
import { CANVAS_ORIGIN, readJson } from "./request.js";

export interface CanvasReadOptions extends CanvasOperationOptions {
  caller: string;
  fresh?: boolean;
  continuation?: string;
  maxPages?: number;
}
export interface CanvasSourceResult {
  source: string;
  coverage: "complete" | "partial" | "unavailable" | "not_requested";
  data: unknown[];
  retrievedAt: string | null;
  cacheAgeMs: number;
  warnings: CanvasConnectionErrorCode[];
}
export interface CanvasResult {
  sources: CanvasSourceResult[];
  continuation?: string;
}
export interface CanvasTransport {
  read(read: CanvasRead, options: CanvasReadOptions): Promise<CanvasResult>;
  aggregate(reads: readonly CanvasRead[], options: CanvasReadOptions): Promise<CanvasResult>;
  invalidate(): void;
}
interface Progress {
  next: string | undefined;
  visited: Set<string>;
  seen: Set<string>;
  done: boolean;
  retrievedAt: string | null;
  coverage: CanvasSourceResult["coverage"];
  warnings: CanvasConnectionErrorCode[];
}
interface Continuation {
  key: string;
  generation: string;
  expires: number;
  progress: Progress[];
}

function safeNext(response: Response, initial: URL): string | undefined {
  const header = response.headers.get("link");
  if (!header) return undefined;
  if (header.length > 16_384) throw new CanvasConnectionError("CANVAS_UNSAFE_PAGINATION");
  const entries = header.split(/,(?=\s*<)/u);
  let next: string | undefined;
  for (const entry of entries) {
    const match = /^\s*<([^>]+)>\s*((?:;[^;]*)*)$/u.exec(entry);
    if (!match) throw new CanvasConnectionError("CANVAS_UNSAFE_PAGINATION");
    const parameters = match[2] ?? "";
    const rel = /;\s*rel\s*=\s*(?:"([^"]+)"|([A-Za-z][A-Za-z0-9_-]*))(?=\s*(?:;|$))/iu.exec(
      parameters,
    );
    if (!rel || [...parameters.matchAll(/;\s*rel\s*=/giu)].length !== 1)
      throw new CanvasConnectionError("CANVAS_UNSAFE_PAGINATION");
    if (!(rel[1] ?? rel[2] ?? "").split(/\s+/u).includes("next")) continue;
    if (next !== undefined) throw new CanvasConnectionError("CANVAS_UNSAFE_PAGINATION");
    let url: URL;
    try {
      url = new URL(match[1] ?? "");
    } catch {
      throw new CanvasConnectionError("CANVAS_UNSAFE_PAGINATION");
    }
    if (
      url.origin !== CANVAS_ORIGIN ||
      url.pathname !== initial.pathname ||
      url.username ||
      url.password ||
      url.hash ||
      url.href.length > 8192
    )
      throw new CanvasConnectionError("CANVAS_UNSAFE_PAGINATION");
    for (const key of url.searchParams.keys()) {
      if (/token|as_user_id|user_id|student_id/iu.test(key))
        throw new CanvasConnectionError("CANVAS_UNSAFE_PAGINATION");
    }
    // Opaque page tokens may change, but selectors and filters cannot widen the original read.
    for (const key of initial.searchParams.keys()) {
      if (key === "page" || key === "per_page") continue;
      if (
        JSON.stringify(initial.searchParams.getAll(key)) !==
        JSON.stringify(url.searchParams.getAll(key))
      )
        throw new CanvasConnectionError("CANVAS_UNSAFE_PAGINATION");
    }
    const knownFilters =
      /^(?:include|exclude|context_codes|course_ids|enrollment_type|enrollment_state|type|start_date|end_date|all_events|scope|filter|state|search_term)(?:\[\])?$/u;
    for (const key of url.searchParams.keys())
      if (knownFilters.test(key) && !initial.searchParams.has(key))
        throw new CanvasConnectionError("CANVAS_UNSAFE_PAGINATION");
    next = url.href;
  }
  return next;
}

function itemIdentity(value: unknown): string {
  let identity: unknown = value;
  if (value && typeof value === "object") {
    if ("id" in value) identity = value.id;
    else if ("page_id" in value) identity = value.page_id;
    else if ("plannable_id" in value && "plannable_type" in value)
      identity = [
        value.plannable_type,
        value.plannable_id,
        "course_id" in value ? value.course_id : null,
      ];
    else if ("course_id" in value && "user_id" in value && "type" in value)
      identity = [value.course_id, value.user_id, value.type];
  }
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function createCanvasTransport(connection: CanvasConnection): CanvasTransport {
  const cache = new Map<string, { generation: string; at: number; result: CanvasResult }>();
  const cursors = new Map<string, Continuation>();
  let generation: string | undefined;
  function invalidate() {
    cache.clear();
    cursors.clear();
  }

  async function aggregate(
    reads: readonly CanvasRead[],
    options: CanvasReadOptions,
    operation: "read" | "aggregate",
  ): Promise<CanvasResult> {
    if (!options.caller || options.caller.length > 256 || reads.length < 1 || reads.length > 20)
      throw new Error("Invalid Canvas operation.");
    const maxPages = options.maxPages ?? 5;
    if (
      !Number.isInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > 20 ||
      (options.fresh && options.continuation)
    )
      throw new Error("Invalid Canvas pagination options.");
    const endpoints = reads.map(buildEndpoint);
    const key = JSON.stringify([
      operation,
      options.caller,
      endpoints.map((endpoint) => endpoint.url.href),
    ]);
    const settings: CanvasOperationOptions = {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.maxRequests === undefined ? {} : { maxRequests: options.maxRequests }),
    };
    return connection.withSession(async (session: CanvasSession) => {
      if (generation !== session.generation) {
        invalidate();
        generation = session.generation;
      }
      const now = Date.now();
      for (const [cursor, state] of cursors) if (state.expires <= now) cursors.delete(cursor);
      for (const [entry, value] of cache) if (now - value.at >= 60_000) cache.delete(entry);
      const cached = cache.get(key);
      if (!options.fresh && !options.continuation && cached?.generation === session.generation) {
        const result = structuredClone(cached.result);
        for (const source of result.sources) source.cacheAgeMs = now - cached.at;
        return result;
      }
      cache.delete(key);
      const state = options.continuation ? cursors.get(options.continuation) : undefined;
      if (
        options.continuation &&
        (!state || state.key !== key || state.generation !== session.generation)
      )
        throw new CanvasConnectionError("CANVAS_INVALID_CURSOR");
      const progress: Progress[] = state
        ? structuredClone(state.progress)
        : endpoints.map((endpoint) => ({
            next: endpoint.url.href,
            visited: new Set<string>(),
            seen: new Set<string>(),
            done: false,
            retrievedAt: null,
            coverage: "not_requested" as const,
            warnings: [],
          }));
      const result: CanvasResult = { sources: [] };
      let pages = 0;
      let items = 0;
      let bytes = 0;
      for (const [index, endpoint] of endpoints.entries()) {
        const current = progress[index];
        if (!current) throw new CanvasConnectionError("CANVAS_INVALID_CURSOR");
        const source: CanvasSourceResult = {
          source: endpoint.source,
          coverage: current.done ? current.coverage : "not_requested",
          data: [],
          retrievedAt: current.retrievedAt,
          cacheAgeMs: 0,
          warnings: current.done ? [...current.warnings] : [],
        };
        result.sources.push(source);
        if (current.done) continue;
        try {
          while (current.next && pages < maxPages && session.budget.remaining > 0 && items < 1000) {
            const visitedKey = createHash("sha256").update(current.next).digest("hex");
            if (current.visited.has(visitedKey) || current.visited.size >= 100)
              throw new CanvasConnectionError("CANVAS_UNSAFE_PAGINATION");
            source.retrievedAt = new Date().toISOString();
            const response = await session.request(new URL(current.next));
            const parsed = endpoint.schema.safeParse(await readJson(response, session.budget));
            if (!parsed.success) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
            const values: unknown[] = endpoint.list ? (parsed.data as unknown[]) : [parsed.data];
            if (values.length > 1000 - items)
              throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
            bytes += Buffer.byteLength(JSON.stringify(values));
            if (
              bytes > 2_097_152 ||
              progress.reduce((sum, entry) => sum + entry.seen.size, 0) + values.length > 5000
            )
              throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
            const next = endpoint.list ? safeNext(response, endpoint.url) : undefined;
            if (
              next &&
              (next === current.next ||
                current.visited.has(createHash("sha256").update(next).digest("hex")))
            )
              throw new CanvasConnectionError("CANVAS_UNSAFE_PAGINATION");
            current.visited.add(visitedKey);
            for (const value of values) {
              const identity = itemIdentity(value);
              if (!current.seen.has(identity)) {
                source.data.push(value);
                current.seen.add(identity);
                items++;
              }
            }
            current.next = next;
            pages++;
          }
          current.done = !current.next;
          source.coverage = current.done
            ? "complete"
            : source.data.length
              ? "partial"
              : "not_requested";
          if (!current.done) source.warnings.push("CANVAS_BUDGET_EXHAUSTED");
        } catch (error) {
          if (!(error instanceof CanvasConnectionError)) throw error;
          if (["REQUEST_CANCELLED", "CANVAS_CREDENTIAL_REJECTED"].includes(error.code)) throw error;
          source.coverage = source.data.length ? "partial" : "unavailable";
          source.warnings.push(error.code);
          if (error.code !== "CANVAS_BUDGET_EXHAUSTED") {
            current.done = true;
            current.next = undefined;
          }
        }
        current.retrievedAt = source.retrievedAt;
        current.coverage = source.coverage;
        current.warnings = [...source.warnings];
      }
      if (options.continuation) cursors.delete(options.continuation);
      if (progress.some((source) => !source.done)) {
        const cursor = randomBytes(24).toString("base64url");
        if (cursors.size >= 64) cursors.delete(cursors.keys().next().value ?? "");
        cursors.set(cursor, {
          key,
          generation: session.generation,
          expires: state?.expires ?? now + 300_000,
          progress,
        });
        result.continuation = cursor;
      } else if (!state && result.sources.every((source) => source.coverage === "complete")) {
        if (cache.size >= 64) cache.delete(cache.keys().next().value ?? "");
        cache.set(key, {
          generation: session.generation,
          at: Date.now(),
          result: structuredClone(result),
        });
      }
      return result;
    }, settings);
  }
  return {
    aggregate: (reads, options) => aggregate(reads, options, "aggregate"),
    read: (read, options) => aggregate([read], options, "read"),
    invalidate,
  };
}
