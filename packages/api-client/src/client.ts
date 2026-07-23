import {
  deleteDocumentContract,
  deleteFileContract,
  getDocumentContract,
  healthContract,
  listDocumentsContract,
  listFilesContract,
  putDocumentContract,
  type ApiContract,
  type ApiContractBody,
  type ApiContractQuery,
  type ApiContractResponse,
  type DeleteDocumentBody,
  type DeleteFileBody,
  type DeleteResult,
  type GetDocumentQuery,
  type HealthResponse,
  type ListDocumentsQuery,
  type ListDocumentsResponse,
  type ListFilesQuery,
  type ListFilesResponse,
  type PutDocumentBody,
  type UserDocument,
} from "@unimatrix/shared";

import type {
  ApiClientConfig,
  ApiClientFetch,
  ApiClientResponse,
} from "./config.js";

/**
 * Options accepted by `request()` for a given contract. `body` is only
 * present (and required) when `TContract` declares a `bodySchema`;
 * `query` is only present (and required) when `TContract` declares a
 * `querySchema`. Contracts with neither yield `{}`, so no options object
 * is required at the call site (see `RequiresRequestOptions`).
 */
export type ApiClientRequestOptions<TContract extends ApiContract> =
  (ApiContractBody<TContract> extends never
    ? Record<never, never>
    : { body: ApiContractBody<TContract> }) &
    (ApiContractQuery<TContract> extends undefined
      ? Record<never, never>
      : { query: ApiContractQuery<TContract> });

type RequiresRequestOptions<TContract extends ApiContract> =
  keyof ApiClientRequestOptions<TContract> extends never ? false : true;

export interface ApiClient {
  getHealth(): Promise<HealthResponse>;
  getDocument(query: GetDocumentQuery): Promise<UserDocument>;
  putDocument(body: PutDocumentBody): Promise<UserDocument>;
  deleteDocument(body: DeleteDocumentBody): Promise<DeleteResult>;
  listDocuments(query: ListDocumentsQuery): Promise<ListDocumentsResponse>;
  listFiles(query: ListFilesQuery): Promise<ListFilesResponse>;
  deleteFile(body: DeleteFileBody): Promise<DeleteResult>;
  request<TContract extends ApiContract>(
    contract: TContract,
    ...args: RequiresRequestOptions<TContract> extends true
      ? [options: ApiClientRequestOptions<TContract>]
      : [options?: ApiClientRequestOptions<TContract>]
  ): Promise<ApiContractResponse<TContract>>;
}

/**
 * Best-effort parse of the API's non-2xx error envelope:
 * `{ error: { code, message, statusCode, details? }, requestId }`. Any
 * field may be missing or malformed; callers only get what the payload
 * actually contains.
 */
interface ApiErrorEnvelope {
  readonly error?: {
    readonly code?: unknown;
    readonly details?: unknown;
    readonly message?: unknown;
  };
  readonly requestId?: unknown;
}

export interface ApiClientErrorOptions {
  code?: string;
  details?: unknown;
  requestId?: string;
  status: number;
}

/**
 * Thrown for non-2xx responses (and for responses that fail to parse as
 * JSON). Always carries `status`; carries `code`/`message`/`requestId`
 * too when the response body matches the API's error envelope shape,
 * letting consumers branch on 401 (sign-in) vs 403 (forbidden) without
 * string-matching the message.
 */
export class ApiClientError extends Error {
  readonly code?: string;
  readonly details?: unknown;
  readonly requestId?: string;
  readonly status: number;

  constructor(message: string, options: ApiClientErrorOptions) {
    super(message);
    this.name = "ApiClientError";
    this.status = options.status;

    if (options.code !== undefined) {
      this.code = options.code;
    }

    if (options.requestId !== undefined) {
      this.requestId = options.requestId;
    }

    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

function buildRequestUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function stringifyQueryValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function buildQueryString(query: unknown): string {
  if (query === undefined || query === null || typeof query !== "object") {
    return "";
  }

  // Built manually with `encodeURIComponent` (a standard ES global) rather
  // than `URLSearchParams` so this package stays free of DOM/Node lib types
  // and matches its deliberately runtime-agnostic fetch abstraction.
  const parts: string[] = [];

  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined) {
      continue;
    }

    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(stringifyQueryValue(value))}`);
  }

  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

function resolveFetch(fetchImpl?: ApiClientFetch): ApiClientFetch {
  if (fetchImpl) {
    return fetchImpl;
  }

  const globalFetch = (globalThis as { fetch?: ApiClientFetch }).fetch;

  if (!globalFetch) {
    throw new Error("No fetch implementation is available for the API client.");
  }

  return globalFetch.bind(globalThis);
}

async function buildErrorFromResponse(
  response: ApiClientResponse,
  contract: ApiContract,
): Promise<ApiClientError> {
  const fallbackMessage = `${contract.method} ${contract.path} failed with status ${response.status}.`;

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    return new ApiClientError(fallbackMessage, { status: response.status });
  }

  if (typeof payload !== "object" || payload === null) {
    return new ApiClientError(fallbackMessage, { status: response.status });
  }

  const envelope = payload as ApiErrorEnvelope;
  const errorInfo = envelope.error;
  const message =
    errorInfo && typeof errorInfo.message === "string" && errorInfo.message.length > 0
      ? errorInfo.message
      : fallbackMessage;

  return new ApiClientError(message, {
    status: response.status,
    ...(errorInfo && typeof errorInfo.code === "string" ? { code: errorInfo.code } : {}),
    ...(typeof envelope.requestId === "string" ? { requestId: envelope.requestId } : {}),
    ...(errorInfo && "details" in errorInfo ? { details: errorInfo.details } : {}),
  });
}

async function parseResponse<TContract extends ApiContract>(
  response: ApiClientResponse,
  contract: TContract,
): Promise<ApiContractResponse<TContract>> {
  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new ApiClientError(`${contract.method} ${contract.path} returned a non-JSON response.`, {
      status: response.status,
    });
  }

  return contract.responseSchema.parse(payload) as ApiContractResponse<TContract>;
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  const fetchImpl = resolveFetch(config.fetch);
  const headers = {
    accept: "application/json",
    ...config.defaultHeaders,
  } satisfies Record<string, string>;

  const request = async <TContract extends ApiContract>(
    contract: TContract,
    options?: ApiClientRequestOptions<TContract>,
  ): Promise<ApiContractResponse<TContract>> => {
    const requestHeaders: Record<string, string> = { ...headers };

    const token = config.getAuthToken ? await config.getAuthToken() : undefined;

    if (token) {
      requestHeaders.authorization = `Bearer ${token}`;
    }

    const hasBody = options !== undefined && "body" in options && options.body !== undefined;
    const query = options !== undefined && "query" in options ? options.query : undefined;
    const queryString = buildQueryString(query);

    const requestInit: { body?: string; headers: Record<string, string>; method: string } = {
      headers: requestHeaders,
      method: contract.method,
    };

    if (hasBody) {
      requestHeaders["content-type"] = "application/json";
      requestInit.body = JSON.stringify((options as { body: unknown }).body);
    }

    const response = await fetchImpl(
      `${buildRequestUrl(config.baseUrl, contract.path)}${queryString}`,
      requestInit,
    );

    if (!response.ok) {
      throw await buildErrorFromResponse(response, contract);
    }

    return parseResponse(response, contract);
  };

  return {
    getHealth: () => request(healthContract),
    getDocument: (query: GetDocumentQuery) =>
      request<typeof getDocumentContract>(getDocumentContract, { query }),
    putDocument: (body: PutDocumentBody) =>
      request<typeof putDocumentContract>(putDocumentContract, { body }),
    deleteDocument: (body: DeleteDocumentBody) =>
      request<typeof deleteDocumentContract>(deleteDocumentContract, { body }),
    listDocuments: (query: ListDocumentsQuery) =>
      request<typeof listDocumentsContract>(listDocumentsContract, { query }),
    listFiles: (query: ListFilesQuery) => request<typeof listFilesContract>(listFilesContract, { query }),
    deleteFile: (body: DeleteFileBody) => request<typeof deleteFileContract>(deleteFileContract, { body }),
    request,
  };
}
