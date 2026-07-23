import type {
  ApiClientAuthTokenProvider,
  ApiClientResponse,
} from "@unimatrix/api-client";
import type { UserFileMetadata } from "@unimatrix/shared";

import { ApiClientError, createApiClient } from "@unimatrix/api-client";

import type { UserFilesStore, UserFilesUploadOptions, UserSettingsStore, UserStore } from "./types.js";
import { assertValidKey, assertValidNamespace } from "./validation.js";

/**
 * Minimal init shape accepted by {@link AccountFetch} — a subset of DOM's
 * `RequestInit` covering only what the binary upload/download calls need.
 */
export interface AccountFetchInit {
  body?: BodyInit;
  headers?: Record<string, string>;
  method?: string;
}

/**
 * The account adapter's `ApiClientResponse` plus `blob()`, since the raw
 * binary download call needs to read the response body as a `Blob`. A real
 * `fetch`'s `Response` satisfies this structurally, so no adapter is
 * required to wire the default in.
 */
export interface AccountFetchResponse extends ApiClientResponse {
  blob(): Promise<Blob>;
}

export type AccountFetch = (input: string, init?: AccountFetchInit) => Promise<AccountFetchResponse>;

export interface CreateAccountUserStoreOptions {
  /** The service/feature namespace this store's documents and files are scoped to. */
  namespace: string;
  /** API base URL — may be relative (e.g. `/api`) for a same-origin fetch. */
  baseUrl: string;
  /** Resolved fresh on every request; see `@unimatrix/api-client`'s `ApiClientAuthTokenProvider`. */
  getToken: ApiClientAuthTokenProvider;
  /** Override for tests; defaults to `globalThis.fetch`. */
  fetch?: AccountFetch;
}

function defaultFetch(input: string, init?: AccountFetchInit): Promise<AccountFetchResponse> {
  return globalThis.fetch(input, init);
}

function buildQueryString(params: Record<string, string>): string {
  const parts = Object.entries(params).map(
    ([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
  );

  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * Server-backed `UserStore` adapter. JSON operations (settings + file
 * metadata/delete) delegate to `@unimatrix/api-client`'s typed methods;
 * binary upload/download use a raw `fetch` since those endpoints are not
 * JSON contracts (see `@unimatrix/api-client`'s README).
 */
export function createAccountUserStore(options: CreateAccountUserStoreOptions): UserStore {
  const namespace = assertValidNamespace(options.namespace);
  const { baseUrl, getToken } = options;
  const fetchImpl = options.fetch ?? defaultFetch;

  const client = createApiClient({ baseUrl, getAuthToken: getToken, fetch: fetchImpl });

  async function authHeaders(): Promise<Record<string, string>> {
    const token = await getToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  const settings: UserSettingsStore = {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const validKey = assertValidKey(key);

      try {
        const document = await client.getDocument({ namespace, key: validKey });
        return document.value as T;
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 404) {
          return undefined;
        }

        throw error;
      }
    },

    async set<T = unknown>(key: string, value: T): Promise<void> {
      const validKey = assertValidKey(key);
      await client.putDocument({ namespace, key: validKey, value });
    },

    async delete(key: string): Promise<void> {
      const validKey = assertValidKey(key);
      await client.deleteDocument({ namespace, key: validKey });
    },

    async list(): Promise<Array<{ key: string; value: unknown }>> {
      const { documents } = await client.listDocuments({ namespace });
      return documents.map((document) => ({ key: document.key, value: document.value }));
    },
  };

  const files: UserFilesStore = {
    async upload(
      key: string,
      file: Blob,
      uploadOptions?: UserFilesUploadOptions,
    ): Promise<UserFileMetadata> {
      const validKey = assertValidKey(key);
      const contentType = uploadOptions?.contentType;
      const blobToSend = contentType && contentType !== file.type ? new Blob([file], { type: contentType }) : file;

      const formData = new FormData();
      formData.append("file", blobToSend);

      const headers = await authHeaders();
      const url = joinUrl(baseUrl, `/me/files${buildQueryString({ namespace, key: validKey })}`);
      const response = await fetchImpl(url, { method: "POST", headers, body: formData });

      if (!response.ok) {
        throw new Error(`Upload failed for "${namespace}/${validKey}" with status ${response.status}.`);
      }

      return (await response.json()) as UserFileMetadata;
    },

    async getBlob(key: string): Promise<Blob | undefined> {
      const validKey = assertValidKey(key);
      const headers = await authHeaders();
      const url = joinUrl(baseUrl, `/me/files/content${buildQueryString({ namespace, key: validKey })}`);
      const response = await fetchImpl(url, { method: "GET", headers });

      if (response.status === 404) {
        return undefined;
      }

      if (!response.ok) {
        throw new Error(`Download failed for "${namespace}/${validKey}" with status ${response.status}.`);
      }

      return response.blob();
    },

    async getObjectUrl(key: string): Promise<string | undefined> {
      const blob = await files.getBlob(key);
      return blob ? URL.createObjectURL(blob) : undefined;
    },

    async list(): Promise<UserFileMetadata[]> {
      const { files: fileList } = await client.listFiles({ namespace });
      return fileList;
    },

    async delete(key: string): Promise<void> {
      const validKey = assertValidKey(key);
      await client.deleteFile({ namespace, key: validKey });
    },
  };

  return { mode: "account", settings, files };
}
