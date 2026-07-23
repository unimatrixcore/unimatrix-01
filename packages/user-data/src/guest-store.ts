import type { UserFileMetadata } from "@unimatrix/shared";

import type { UserFilesStore, UserFilesUploadOptions, UserSettingsStore, UserStore } from "./types.js";
import { assertValidKey, assertValidNamespace } from "./validation.js";

const DATABASE_NAME = "unimatrix-user-data";
const DATABASE_VERSION = 1;
const DOCUMENTS_STORE = "documents";
const FILES_STORE = "files";
const NAMESPACE_INDEX = "byNamespace";

interface DocumentRecord {
  namespace: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

interface FileRecord {
  namespace: string;
  key: string;
  blob: Blob;
  contentType: string;
  size: number;
  updatedAt: string;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB request failed."));
    };
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(DOCUMENTS_STORE)) {
        const store = db.createObjectStore(DOCUMENTS_STORE, { keyPath: ["namespace", "key"] });
        store.createIndex(NAMESPACE_INDEX, "namespace");
      }

      if (!db.objectStoreNames.contains(FILES_STORE)) {
        const store = db.createObjectStore(FILES_STORE, { keyPath: ["namespace", "key"] });
        store.createIndex(NAMESPACE_INDEX, "namespace");
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("Failed to open the IndexedDB database."));
    };
  });
}

// Module-level singleton: one open connection to the shared
// "unimatrix-user-data" database per page, reused by every guest store
// instance regardless of namespace.
let databasePromise: Promise<IDBDatabase> | undefined;

function getDatabase(): Promise<IDBDatabase> {
  databasePromise ??= openDatabase();
  return databasePromise;
}

export interface CreateGuestUserStoreOptions {
  /** The service/feature namespace this store's documents and files are scoped to. */
  namespace: string;
}

/**
 * Browser-only, no-network `UserStore` adapter backed by IndexedDB. One
 * database (`unimatrix-user-data`) holds two object stores — `documents`
 * and `files` — both keyed by `[namespace, key]`, so every guest store
 * instance (regardless of namespace) shares the same database connection.
 * Mirrors the account adapter's validation and `undefined`-on-miss
 * semantics so a service can switch modes transparently.
 */
export function createGuestUserStore(options: CreateGuestUserStoreOptions): UserStore {
  const namespace = assertValidNamespace(options.namespace);

  const settings: UserSettingsStore = {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const validKey = assertValidKey(key);
      const db = await getDatabase();
      const tx = db.transaction(DOCUMENTS_STORE, "readonly");
      const record = await requestToPromise<DocumentRecord | undefined>(
        tx.objectStore(DOCUMENTS_STORE).get([namespace, validKey]) as IDBRequest<DocumentRecord | undefined>,
      );
      return record?.value as T | undefined;
    },

    async set<T = unknown>(key: string, value: T): Promise<void> {
      const validKey = assertValidKey(key);
      const db = await getDatabase();
      const tx = db.transaction(DOCUMENTS_STORE, "readwrite");
      const record: DocumentRecord = {
        namespace,
        key: validKey,
        value,
        updatedAt: new Date().toISOString(),
      };
      await requestToPromise(tx.objectStore(DOCUMENTS_STORE).put(record));
    },

    async delete(key: string): Promise<void> {
      const validKey = assertValidKey(key);
      const db = await getDatabase();
      const tx = db.transaction(DOCUMENTS_STORE, "readwrite");
      await requestToPromise(tx.objectStore(DOCUMENTS_STORE).delete([namespace, validKey]));
    },

    async list(): Promise<Array<{ key: string; value: unknown }>> {
      const db = await getDatabase();
      const tx = db.transaction(DOCUMENTS_STORE, "readonly");
      const index = tx.objectStore(DOCUMENTS_STORE).index(NAMESPACE_INDEX);
      const records = await requestToPromise<DocumentRecord[]>(
        index.getAll(namespace) as IDBRequest<DocumentRecord[]>,
      );
      return records.map((record) => ({ key: record.key, value: record.value }));
    },
  };

  const files: UserFilesStore = {
    async upload(
      key: string,
      file: Blob,
      uploadOptions?: UserFilesUploadOptions,
    ): Promise<UserFileMetadata> {
      const validKey = assertValidKey(key);
      const contentType = uploadOptions?.contentType ?? file.type ?? "application/octet-stream";
      const blob = uploadOptions?.contentType && uploadOptions.contentType !== file.type
        ? new Blob([file], { type: contentType })
        : file;
      const updatedAt = new Date().toISOString();

      const db = await getDatabase();
      const tx = db.transaction(FILES_STORE, "readwrite");
      const record: FileRecord = {
        namespace,
        key: validKey,
        blob,
        contentType,
        size: blob.size,
        updatedAt,
      };
      await requestToPromise(tx.objectStore(FILES_STORE).put(record));

      return { namespace, key: validKey, contentType, size: blob.size, updatedAt };
    },

    async getBlob(key: string): Promise<Blob | undefined> {
      const validKey = assertValidKey(key);
      const db = await getDatabase();
      const tx = db.transaction(FILES_STORE, "readonly");
      const record = await requestToPromise<FileRecord | undefined>(
        tx.objectStore(FILES_STORE).get([namespace, validKey]) as IDBRequest<FileRecord | undefined>,
      );
      return record?.blob;
    },

    async getObjectUrl(key: string): Promise<string | undefined> {
      const blob = await files.getBlob(key);
      return blob ? URL.createObjectURL(blob) : undefined;
    },

    async list(): Promise<UserFileMetadata[]> {
      const db = await getDatabase();
      const tx = db.transaction(FILES_STORE, "readonly");
      const index = tx.objectStore(FILES_STORE).index(NAMESPACE_INDEX);
      const records = await requestToPromise<FileRecord[]>(
        index.getAll(namespace) as IDBRequest<FileRecord[]>,
      );
      return records.map((record) => ({
        namespace: record.namespace,
        key: record.key,
        contentType: record.contentType,
        size: record.size,
        updatedAt: record.updatedAt,
      }));
    },

    async delete(key: string): Promise<void> {
      const validKey = assertValidKey(key);
      const db = await getDatabase();
      const tx = db.transaction(FILES_STORE, "readwrite");
      await requestToPromise(tx.objectStore(FILES_STORE).delete([namespace, validKey]));
    },
  };

  return { mode: "guest", settings, files };
}
