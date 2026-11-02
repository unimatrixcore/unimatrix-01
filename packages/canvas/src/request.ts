import { CanvasConnectionError } from "./errors.js";

export const CANVAS_ORIGIN = "https://learn.maricopa.edu";
export interface CanvasBudget {
  signal: AbortSignal;
  remaining: number;
}

export function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new CanvasConnectionError("REQUEST_CANCELLED");
}

export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    throw new CanvasConnectionError("REQUEST_CANCELLED");
  }
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(new CanvasConnectionError("REQUEST_CANCELLED"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await abortable(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.min(ms, 2_147_483_647));
      }),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function readJson(
  response: Response,
  budget: CanvasBudget,
  maxBytes = 1_048_576,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await abortable(reader.read(), budget.signal);
      if (result.done) break;
      const value: unknown = result.value;
      if (!(value instanceof Uint8Array))
        throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
      length += value.length;
      if (length > maxBytes) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof CanvasConnectionError) throw error;
    throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
  } finally {
    reader.releaseLock();
  }
}

export function createCanvasRequester(fetchImpl: typeof globalThis.fetch) {
  let blockedUntil = 0;
  return async (url: URL, token: string, budget: CanvasBudget): Promise<Response> => {
    if (
      url.origin !== CANVAS_ORIGIN ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith("/api/v1/")
    )
      throw new CanvasConnectionError("CANVAS_UNSAFE_PAGINATION");
    for (let attempt = 0; ; attempt++) {
      checkSignal(budget.signal);
      if (budget.remaining <= 0) throw new CanvasConnectionError("CANVAS_BUDGET_EXHAUSTED");
      await pause(Math.max(0, blockedUntil - Date.now()), budget.signal);
      budget.remaining--;
      let response: Response;
      try {
        response = await abortable(
          fetchImpl(url.href, {
            method: "GET",
            redirect: "error",
            signal: budget.signal,
            headers: {
              accept: "application/json+canvas-string-ids",
              authorization: `Bearer ${token}`,
            },
          }),
          budget.signal,
        );
      } catch (error) {
        if (error instanceof CanvasConnectionError) throw error;
        throw new CanvasConnectionError("CANVAS_REQUEST_FAILED");
      }
      const retry = response.headers.get("retry-after");
      const retryMs =
        retry === null
          ? 0
          : /^\d+(?:\.\d+)?$/u.test(retry)
            ? Number(retry) * 1000
            : Math.max(0, Date.parse(retry) - Date.now());
      const cost = Number(response.headers.get("x-request-cost") ?? 0);
      const remaining = Number(response.headers.get("x-rate-limit-remaining") ?? Infinity);
      const delay = Math.max(
        Number.isFinite(retryMs) ? retryMs : 0,
        Number.isFinite(cost) && cost > 0 && (remaining <= 0 || remaining < cost) ? 1000 : 0,
      );
      blockedUntil = Math.max(blockedUntil, Date.now() + delay);
      if (response.ok) return response;
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 401) throw new CanvasConnectionError("CANVAS_CREDENTIAL_REJECTED");
      if (response.status === 403 || response.status === 404)
        throw new CanvasConnectionError("CANVAS_RESOURCE_UNAVAILABLE");
      if ((response.status === 429 || response.status === 503) && attempt < 2) {
        blockedUntil = Math.max(
          blockedUntil,
          Date.now() + 100 * 2 ** attempt + Math.random() * 100,
        );
        continue;
      }
      throw new CanvasConnectionError("CANVAS_UNAVAILABLE");
    }
  };
}
