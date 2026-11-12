import { abortableDelay } from "./policy";

export interface ListPage<T, Cursor> {
  items: readonly T[];
  nextCursor: Cursor | null;
}
export interface FetchPageContext<Cursor> {
  cursor: Cursor | null;
  signal: AbortSignal;
  priority: "high" | "low";
  limit: number;
}
export type FetchListPage<T, Cursor> = (
  context: FetchPageContext<Cursor>,
) => Promise<ListPage<T, Cursor>>;
export class ListTransportError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ListTransportError";
  }
}
export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
export interface HttpPageOptions<T, Cursor> {
  url: (context: FetchPageContext<Cursor>) => string | URL;
  parse: (value: unknown) => ListPage<T, Cursor>;
  init?: RequestInit;
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
}
export function createHttpPageFetcher<T, Cursor>(
  options: HttpPageOptions<T, Cursor>,
): FetchListPage<T, Cursor> {
  return async (context) => {
    for (let attempt = 0; ; attempt++) {
      context.signal.throwIfAborted();
      const response = await (options.fetch ?? globalThis.fetch)(options.url(context), {
        ...options.init,
        signal: context.signal,
        priority: context.priority,
      });
      if (response.ok) return options.parse(await response.json());
      if (
        (response.status !== 429 && response.status !== 503) ||
        attempt >= (options.maxRetries ?? 3)
      )
        throw new ListTransportError(`List request failed (${response.status})`, response.status);
      const delay =
        retryAfterMilliseconds(response.headers.get("Retry-After")) ??
        Math.min(30_000, 1_000 * 2 ** attempt);
      // Never retry earlier than Retry-After; exceptionally long limits surface for explicit retry.
      if (delay > 5 * 60_000)
        throw new ListTransportError("List request is rate limited", response.status);
      await response.body?.cancel();
      await abortableDelay(delay, context.signal);
    }
  };
}
export interface InvokePageOptions<T, Cursor> {
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  command: string;
  args?: Record<string, unknown>;
  parse: (value: unknown) => ListPage<T, Cursor>;
}
export function createInvokePageFetcher<T, Cursor>(
  options: InvokePageOptions<T, Cursor>,
): FetchListPage<T, Cursor> {
  return async (context) => {
    context.signal.throwIfAborted();
    try {
      const result = await options.invoke(options.command, {
        ...options.args,
        cursor: context.cursor,
        limit: Math.min(500, Math.max(1, context.limit)),
      });
      context.signal.throwIfAborted();
      return options.parse(result);
    } catch (error) {
      context.signal.throwIfAborted();
      throw new ListTransportError(
        "Desktop list command failed",
        undefined,
        typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
          ? error.code
          : "IPC_ERROR",
      );
    }
  };
}

export function withListRetry<T, Cursor>(
  fetchPage: FetchListPage<T, Cursor>,
  maxRetries = 3,
): FetchListPage<T, Cursor> {
  return async (context) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetchPage(context);
      } catch (error) {
        context.signal.throwIfAborted();
        if (error instanceof ListTransportError) throw error;
        const status =
          typeof error === "object" && error !== null && "status" in error
            ? error.status
            : undefined;
        if ((status !== 429 && status !== 503) || attempt >= maxRetries) throw error;
        const retryAfter =
          "retryAfterMs" in (error as object)
            ? (error as { retryAfterMs?: unknown }).retryAfterMs
            : undefined;
        const delay =
          typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0
            ? retryAfter
            : Math.min(30_000, 1_000 * 2 ** attempt);
        if (delay > 5 * 60_000) throw error;
        await abortableDelay(delay, context.signal);
      }
    }
  };
}
