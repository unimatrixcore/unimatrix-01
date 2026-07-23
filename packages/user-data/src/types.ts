import type { UserFileMetadata } from "@unimatrix/shared";

/**
 * A single namespaced JSON document store. `get`/`set`/`delete`/`list` all
 * operate within the namespace a `UserStore` was created for — callers
 * never pass a namespace themselves.
 */
export interface UserSettingsStore {
  /** Resolves `undefined` when no document exists for `key` (never throws for "missing"). */
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<Array<{ key: string; value: unknown }>>;
}

/** Options accepted by {@link UserFilesStore.upload}. */
export interface UserFilesUploadOptions {
  /** Overrides the blob's own `type`; falls back to `file.type` when omitted. */
  contentType?: string;
}

/**
 * A single namespaced file store. Files are addressed by `key` the same
 * way documents are; `getObjectUrl` is a convenience over `getBlob` — the
 * caller is responsible for calling `URL.revokeObjectURL(url)` once done
 * with it.
 */
export interface UserFilesStore {
  upload(key: string, file: Blob, options?: UserFilesUploadOptions): Promise<UserFileMetadata>;
  /** Resolves `undefined` when no file exists for `key`. */
  getBlob(key: string): Promise<Blob | undefined>;
  /** Resolves `undefined` when no file exists for `key`. */
  getObjectUrl(key: string): Promise<string | undefined>;
  list(): Promise<UserFileMetadata[]>;
  delete(key: string): Promise<void>;
}

/**
 * A namespaced per-user data store. `mode` reports which adapter backs the
 * instance — `"account"` (server-backed via `@unimatrix/api-client`) or
 * `"guest"` (browser-local IndexedDB) — so a service can display it or
 * branch on it, but both adapters expose an identical `settings`/`files`
 * surface so callers otherwise don't need to care.
 */
export interface UserStore {
  readonly mode: "account" | "guest";
  settings: UserSettingsStore;
  files: UserFilesStore;
}
