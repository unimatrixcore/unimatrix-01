import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";

const errors = {
  CREDENTIAL_DENIED: [503, "Canvas credential access was denied."],
  CREDENTIAL_MISSING: [503, "Canvas integration credential is missing or inaccessible."],
  CREDENTIAL_UNAVAILABLE: [503, "Canvas credential store is unavailable."],
  CANVAS_ACCOUNT_MISMATCH: [409, "Canvas credential belongs to a different account."],
  CANVAS_CREDENTIAL_REJECTED: [502, "Canvas rejected the integration credential."],
  CANVAS_UNAVAILABLE: [502, "Canvas is unavailable."],
  CANVAS_INVALID_RESPONSE: [502, "Canvas returned an invalid account response."],
  CANVAS_REQUEST_FAILED: [502, "Canvas request failed."],
  REQUEST_CANCELLED: [503, "Canvas operation was cancelled."],
} as const;

export type CanvasConnectionErrorCode = keyof typeof errors;

export class CanvasConnectionError extends Error {
  readonly code: CanvasConnectionErrorCode;
  readonly statusCode: 409 | 502 | 503;

  constructor(code: CanvasConnectionErrorCode) {
    super(errors[code][1]);
    this.name = "CanvasConnectionError";
    this.code = code;
    this.statusCode = errors[code][0];
  }
}

export interface CanvasConnectionStatus {
  connection: "connected";
}

export interface CanvasConnectionOptions {
  userId: string;
  loadCredential: (signal?: AbortSignal) => Promise<string>;
  fetch?: typeof globalThis.fetch;
  onCredentialChange?: () => void;
}

export interface CanvasConnection {
  status(signal?: AbortSignal): Promise<CanvasConnectionStatus>;
  withVerifiedCredential<T>(
    operation: (token: string, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

const accountSchema = z.object({ id: z.string().regex(/^[1-9]\d*$/u) });
const ACCOUNT_URL = "https://learn.maricopa.edu/api/v1/users/self";
const MAX_ACCOUNT_BYTES = 65_536;

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new CanvasConnectionError("REQUEST_CANCELLED");
}

async function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  checkSignal(signal);
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(new CanvasConnectionError("REQUEST_CANCELLED"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([previous, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function readAccount(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      checkSignal(signal);
      const result = await reader.read();
      if (result.done) break;
      const value: unknown = result.value;
      if (!(value instanceof Uint8Array)) {
        throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
      }
      length += value.length;
      if (length > MAX_ACCOUNT_BYTES) {
        await reader.cancel();
        throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
      }
      chunks.push(value);
    }
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const parsed = accountSchema.safeParse(payload);
    if (!parsed.success) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
    return parsed.data.id;
  } catch (error) {
    if (error instanceof CanvasConnectionError) throw error;
    throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
  } finally {
    reader.releaseLock();
  }
}

export function createCanvasConnection(options: CanvasConnectionOptions): CanvasConnection {
  if (!/^[1-9]\d*$/u.test(options.userId)) {
    throw new Error("Invalid configured Canvas user ID.");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const generationKey = randomBytes(32);
  let generation: string | undefined;
  let pending: Promise<void> = Promise.resolve();

  async function withVerifiedCredential<T>(
    operation: (token: string, signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000);
    const previous = pending;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    pending = previous.then(() => gate);
    try {
      await waitForTurn(previous, signal);
      checkSignal(signal);
      let token: string;
      try {
        token = await options.loadCredential(signal);
      } catch (error) {
        checkSignal(signal);
        if (error instanceof CanvasConnectionError) throw error;
        throw new CanvasConnectionError("CREDENTIAL_UNAVAILABLE");
      }
      checkSignal(signal);
      if (!/^[\x21-\x7e]+$/u.test(token)) throw new CanvasConnectionError("CREDENTIAL_DENIED");
      const current = createHmac("sha256", generationKey).update(token).digest("hex");
      if (current !== generation) {
        options.onCredentialChange?.();
        generation = current;
      }
      const response = await fetchImpl(ACCOUNT_URL, {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json+canvas-string-ids",
          authorization: `Bearer ${token}`,
        },
        signal,
      });
      checkSignal(signal);
      if (!response.ok) await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        throw new CanvasConnectionError("CANVAS_CREDENTIAL_REJECTED");
      }
      if (!response.ok) throw new CanvasConnectionError("CANVAS_UNAVAILABLE");
      if ((await readAccount(response, signal)) !== options.userId) {
        throw new CanvasConnectionError("CANVAS_ACCOUNT_MISMATCH");
      }
      checkSignal(signal);
      const result = await operation(token, signal);
      checkSignal(signal);
      return result;
    } catch (error) {
      checkSignal(signal);
      if (error instanceof CanvasConnectionError) throw error;
      throw new CanvasConnectionError("CANVAS_REQUEST_FAILED");
    } finally {
      release();
    }
  }

  return {
    withVerifiedCredential,
    status: (signal) =>
      withVerifiedCredential(() => Promise.resolve({ connection: "connected" }), signal),
  };
}
