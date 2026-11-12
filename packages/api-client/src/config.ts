/**
 * Resolves an auth token to attach as `Authorization: Bearer <token>` on
 * each request. The client is auth-library-agnostic: it never imports
 * Clerk or any other auth SDK, so the consuming app supplies this
 * provider (for example, wrapping Clerk's `getToken()`). Returning
 * `null`, `undefined`, or an empty string omits the header. Resolved
 * per-request rather than cached at construction time.
 */
export type ApiClientAuthTokenProvider = () =>
  string | null | undefined | Promise<string | null | undefined>;

export interface ApiClientConfig {
  baseUrl: string;
  defaultHeaders?: Readonly<Record<string, string>>;
  fetch?: ApiClientFetch;
  getAuthToken?: ApiClientAuthTokenProvider;
}

export interface ApiClientRequestControl {
  readonly signal?: { readonly aborted: boolean; readonly reason: unknown; throwIfAborted(): void };
  readonly priority?: "high" | "low" | "auto";
}

export interface ApiClientRequestInit extends ApiClientRequestControl {
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method?: string;
}

export interface ApiClientResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type ApiClientFetch = (
  input: string,
  init?: ApiClientRequestInit,
) => Promise<ApiClientResponse>;
