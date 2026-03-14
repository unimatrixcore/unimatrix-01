export interface ApiClientConfig {
  baseUrl: string;
  defaultHeaders?: Readonly<Record<string, string>>;
  fetch?: ApiClientFetch;
}

export interface ApiClientRequestInit {
  readonly headers?: Readonly<Record<string, string>>;
  readonly method?: string;
}

export interface ApiClientResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type ApiClientFetch = (
  input: string,
  init?: ApiClientRequestInit,
) => Promise<ApiClientResponse>;
