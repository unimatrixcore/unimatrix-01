import { dokployMutationErrorSchema } from "./schemas.js";

export class DokployClientError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "DokployClientError";
    this.status = status;
  }
}

export interface CreateDokployClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface DokployTransport {
  callProcedure: <T>(
    procedurePath: string,
    schema: { parse: (value: unknown) => T },
    query?: Readonly<Record<string, string>>,
  ) => Promise<T>;
  callMutation: (
    procedurePath: string,
    payload: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
}

export function createDokployTransport(options: CreateDokployClientOptions): DokployTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const baseUrl = options.baseUrl.endsWith("/") ? options.baseUrl.slice(0, -1) : options.baseUrl;

  async function callProcedure<T>(
    procedurePath: string,
    schema: { parse: (value: unknown) => T },
    query?: Readonly<Record<string, string>>,
  ): Promise<T> {
    // Built through URL/URLSearchParams rather than string concatenation, so a query value
    // containing `&` or `#` (a composeId is Dokploy-generated, not user input, but nothing here
    // depends on that staying true) cannot reshape the request past what was intended.
    const url = new URL(`${baseUrl}/api/${procedurePath}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }

    const response = await fetchImpl(url, {
      method: "GET",
      headers: { "x-api-key": options.apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      // Never `await response.text()` here: `project.all` and `compose.one` both return an env
      // blob, and reading the body into this error's message would put it there.
      throw new DokployClientError(
        `Dokploy procedure ${procedurePath} responded with status ${response.status}.`,
        response.status,
      );
    }

    let body: unknown;

    try {
      if (options.maxResponseBytes === undefined) {
        body = await response.json();
      } else {
        const reader = response.body?.getReader();
        if (reader === undefined) throw new Error("Missing response");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const result = await reader.read();
            if (result.done) break;
            const value: unknown = result.value;
            if (!(value instanceof Uint8Array)) throw new Error("Invalid response chunk");
            size += value.byteLength;
            if (size > options.maxResponseBytes) throw new Error("Response limit");
            chunks.push(value);
          }
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      }
    } catch {
      throw new DokployClientError(
        `Dokploy procedure ${procedurePath} did not return a JSON body.`,
        response.status,
      );
    }

    try {
      return schema.parse(body);
    } catch {
      // Never the zod error itself: its `.message` can echo back the offending value, and this
      // class's whole point is never carrying a response-body fragment.
      throw new DokployClientError(
        `Dokploy procedure ${procedurePath} returned a body that failed schema validation.`,
        response.status,
      );
    }
  }

  /**
   * The one mutation path this service has. Never `await response.json()`/`.text()` on a 200: the
   * fork's `update` procedure does `db.update(compose).set(...).where(...)` and returns the whole
   * updated row, `env` plaintext included — reading it would put a secret blob in a value this
   * function returns, the exact thing `callProcedure` above is built to avoid on the read side.
   * `void` on success is the only shape that cannot carry one.
   *
   * On a non-2xx, the body is `{code, message, data: {zodError}, issues}` — field names and zod
   * messages, never the row — so reducing it to key names only is safe in a way reading the 200
   * body never is. Parsed defensively: a body that is not JSON, or does not have the expected
   * shape, degrades to the bare status instead of throwing inside the error path.
   */
  async function callMutation(
    procedurePath: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const url = new URL(`${baseUrl}/api/${procedurePath}`);

    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "x-api-key": options.apiKey, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.ok) {
      return;
    }

    let code: string | undefined;
    let fieldNames: string[] = [];

    try {
      const body: unknown = await response.json();
      const parsed = dokployMutationErrorSchema.safeParse(body);

      if (parsed.success) {
        code = parsed.data.code;
        fieldNames = Object.keys(parsed.data.data?.zodError?.fieldErrors ?? {});
      }
    } catch {
      // Falls through to the bare-status message below — never throws inside the error path.
    }

    const codeSuffix = code !== undefined ? ` (code: ${code})` : "";
    const fieldSuffix = fieldNames.length > 0 ? ` (fields: ${fieldNames.join(", ")})` : "";

    throw new DokployClientError(
      `Dokploy procedure ${procedurePath} responded with status ${response.status}${codeSuffix}${fieldSuffix}.`,
      response.status,
    );
  }

  return { callProcedure, callMutation };
}
