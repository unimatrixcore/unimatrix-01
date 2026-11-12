import {
  adminCreateSecretContract,
  adminDeleteSecretContract,
  adminGetPostContract,
  adminListPostsContract,
  adminListSecretsContract,
  adminRotateSecretContract,
  createPostContract,
  deleteDocumentContract,
  deleteFileContract,
  deletePostsContract,
  getDocumentContract,
  getPostContract,
  healthContract,
  listAssetsContract,
  listDocumentsContract,
  listFilesContract,
  listPostsContract,
  putDocumentContract,
  refreshIntegrationCredentialsContract,
  setPostsStateContract,
  updatePostContract,
  type AdminCreateSecretBody,
  type AdminDeleteSecretBody,
  type AdminDeleteSecretResponse,
  type AdminListPostsQuery,
  type AdminListSecretsResponse,
  type AdminRotateSecretBody,
  type ApiContract,
  type ApiContractBody,
  type ApiContractQuery,
  type ApiContractResponse,
  type BulkResult,
  type ContentPost,
  type CreatePostBody,
  type DeleteDocumentBody,
  type DeleteFileBody,
  type DeletePostsBody,
  type DeleteResult,
  type GetDocumentQuery,
  type GetPostQuery,
  type HealthResponse,
  type ListAssetsResponse,
  type ListDocumentsQuery,
  type ListDocumentsResponse,
  type ListFilesQuery,
  type ListFilesResponse,
  type ListPostsQuery,
  type ListPostsResponse,
  type PutDocumentBody,
  type RefreshIntegrationCredentialsResponse,
  type SecretMetadata,
  type SetPostsStateBody,
  type UpdatePostBody,
  type UserDocument,
} from "@unimatrix/shared";

import type {
  ApiClientConfig,
  ApiClientFetch,
  ApiClientResponse,
  ApiClientRequestControl,
  ApiClientRequestInit,
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
  /** Published content only; safe to call unauthenticated. */
  listPosts(query: ListPostsQuery, control?: ApiClientRequestControl): Promise<ListPostsResponse>;
  getPost(query: GetPostQuery): Promise<ContentPost>;
  /**
   * Admin content operations. Every one of these is rejected with 403 unless
   * the configured `getAuthToken` yields a session holding the `auth` admin
   * role — the client cannot and does not check that itself.
   */
  adminListPosts(
    query: AdminListPostsQuery,
    control?: ApiClientRequestControl,
  ): Promise<ListPostsResponse>;
  adminGetPost(query: GetPostQuery): Promise<ContentPost>;
  createPost(body: CreatePostBody): Promise<ContentPost>;
  updatePost(body: UpdatePostBody): Promise<ContentPost>;
  setPostsState(body: SetPostsStateBody): Promise<BulkResult>;
  deletePosts(body: DeletePostsBody): Promise<BulkResult>;
  listAssets(): Promise<ListAssetsResponse>;
  /**
   * Admin secrets-management operations. Every one of these is rejected with
   * 403 unless the configured `getAuthToken` yields a session holding the
   * `secrets` admin section — the client cannot and does not check that
   * itself. None of these ever returns a decrypted value; `apps/api` has no
   * route that does.
   */
  adminListSecrets(): Promise<AdminListSecretsResponse>;
  adminCreateSecret(body: AdminCreateSecretBody): Promise<SecretMetadata>;
  adminRotateSecret(body: AdminRotateSecretBody): Promise<SecretMetadata>;
  adminDeleteSecret(body: AdminDeleteSecretBody): Promise<AdminDeleteSecretResponse>;
  /**
   * Makes the API re-fetch every integration credential it declares and
   * report the outcome per name. Names only — no value and no masked prefix
   * crosses back. Gated on the same `secrets` admin section as the methods
   * above.
   */
  refreshIntegrationCredentials(): Promise<RefreshIntegrationCredentialsResponse>;
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
  retryAfterMs?: number;
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
  readonly retryAfterMs?: number;

  constructor(message: string, options: ApiClientErrorOptions) {
    super(message);
    this.name = "ApiClientError";
    this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;

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

const SLASH_CHAR_CODE = 47;

/**
 * Slash trimming is done by index rather than with `/\/+$/` and `/^\/+/`.
 * Those are polynomial: on a run of n slashes the engine retries the
 * quantifier from every start position, so cost grows as O(n^2). Measured on
 * Node 22, `"/".repeat(n) + "a"` takes 58ms at n=10k and 3.7s at n=80k — a
 * clean 4x per doubling — while the index scan stays flat at microseconds.
 *
 * `baseUrl` is configuration-supplied and `path` comes from a static
 * `ApiContract`, so neither is attacker-controlled in this repo today. These
 * are still exported-library entry points, and the linear form costs nothing.
 */
function trimTrailingSlashes(value: string): string {
  let end = value.length;

  while (end > 0 && value.charCodeAt(end - 1) === SLASH_CHAR_CODE) {
    end -= 1;
  }

  return value.slice(0, end);
}

function trimLeadingSlashes(value: string): string {
  let start = 0;

  while (start < value.length && value.charCodeAt(start) === SLASH_CHAR_CODE) {
    start += 1;
  }

  return value.slice(start);
}

function buildRequestUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlashes(baseUrl)}/${trimLeadingSlashes(path)}`;
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
  const retryAfter = response.headers?.get("retry-after");
  const retryAfterMs =
    retryAfter == null
      ? undefined
      : /^\d+(\.\d+)?$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : Math.max(0, Date.parse(retryAfter) - Date.now());
  const retryOptions =
    typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {};
  const fallbackMessage = `${contract.method} ${contract.path} failed with status ${response.status}.`;

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    return new ApiClientError(fallbackMessage, { status: response.status, ...retryOptions });
  }

  if (typeof payload !== "object" || payload === null) {
    return new ApiClientError(fallbackMessage, { status: response.status, ...retryOptions });
  }

  const envelope = payload as ApiErrorEnvelope;
  const errorInfo = envelope.error;
  const message =
    errorInfo && typeof errorInfo.message === "string" && errorInfo.message.length > 0
      ? errorInfo.message
      : fallbackMessage;

  return new ApiClientError(message, {
    status: response.status,
    ...retryOptions,
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
    control?: ApiClientRequestControl,
  ): Promise<ApiContractResponse<TContract>> => {
    const requestHeaders: Record<string, string> = { ...headers };

    const token = config.getAuthToken ? await config.getAuthToken() : undefined;

    if (token) {
      requestHeaders.authorization = `Bearer ${token}`;
    }

    const hasBody = options !== undefined && "body" in options && options.body !== undefined;
    const query = options !== undefined && "query" in options ? options.query : undefined;
    const queryString = buildQueryString(query);

    const requestInit: ApiClientRequestInit & { body?: string } = {
      ...control,
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
    listFiles: (query: ListFilesQuery) =>
      request<typeof listFilesContract>(listFilesContract, { query }),
    deleteFile: (body: DeleteFileBody) =>
      request<typeof deleteFileContract>(deleteFileContract, { body }),
    listPosts: (query: ListPostsQuery, control?: ApiClientRequestControl) =>
      request<typeof listPostsContract>(listPostsContract, { query }, control),
    getPost: (query: GetPostQuery) => request<typeof getPostContract>(getPostContract, { query }),
    adminListPosts: (query: AdminListPostsQuery, control?: ApiClientRequestControl) =>
      request<typeof adminListPostsContract>(adminListPostsContract, { query }, control),
    adminGetPost: (query: GetPostQuery) =>
      request<typeof adminGetPostContract>(adminGetPostContract, { query }),
    createPost: (body: CreatePostBody) =>
      request<typeof createPostContract>(createPostContract, { body }),
    updatePost: (body: UpdatePostBody) =>
      request<typeof updatePostContract>(updatePostContract, { body }),
    setPostsState: (body: SetPostsStateBody) =>
      request<typeof setPostsStateContract>(setPostsStateContract, { body }),
    deletePosts: (body: DeletePostsBody) =>
      request<typeof deletePostsContract>(deletePostsContract, { body }),
    listAssets: () => request<typeof listAssetsContract>(listAssetsContract),
    adminListSecrets: () => request<typeof adminListSecretsContract>(adminListSecretsContract),
    adminCreateSecret: (body: AdminCreateSecretBody) =>
      request<typeof adminCreateSecretContract>(adminCreateSecretContract, { body }),
    adminRotateSecret: (body: AdminRotateSecretBody) =>
      request<typeof adminRotateSecretContract>(adminRotateSecretContract, { body }),
    adminDeleteSecret: (body: AdminDeleteSecretBody) =>
      request<typeof adminDeleteSecretContract>(adminDeleteSecretContract, { body }),
    refreshIntegrationCredentials: () =>
      request<typeof refreshIntegrationCredentialsContract>(refreshIntegrationCredentialsContract),
    request,
  };
}
