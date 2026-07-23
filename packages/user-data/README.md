# @unimatrix/user-data

Browser-side per-user data store for the Unimatrix monorepo. A `UserStore` is bound to one service/feature **namespace** and exposes the same `settings` (JSON documents) + `files` (blobs) surface whether the visitor is signed in (`"account"` mode, server-backed) or signed out (`"guest"` mode, local IndexedDB, no network).

## Entry points

| Import path | Runtime | Contents |
| --- | --- | --- |
| `@unimatrix/user-data` | browser (no React dependency) | `UserStore`/`UserSettingsStore`/`UserFilesStore` types, `createAccountUserStore`, `createGuestUserStore`, `createUserStore`, `migrateGuestDataToAccount` |
| `@unimatrix/user-data/react` | browser (React 19) | `useUserStore`, `useGuestDataMigration` |

`./react` **requires an `AuthProvider` (from `@unimatrix/auth/react`) mounted above it** — both hooks call Clerk's `useAuth()` unconditionally. Mounting them outside a provider throws Clerk's own error, not a silent fallback.

## The store interface

```ts
interface UserSettingsStore {
  get<T = unknown>(key: string): Promise<T | undefined>; // undefined when missing, never throws for "missing"
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<Array<{ key: string; value: unknown }>>;
}

interface UserFilesStore {
  upload(key: string, file: Blob, options?: { contentType?: string }): Promise<UserFileMetadata>;
  getBlob(key: string): Promise<Blob | undefined>;
  getObjectUrl(key: string): Promise<string | undefined>; // convenience over getBlob
  list(): Promise<UserFileMetadata[]>;
  delete(key: string): Promise<void>;
}

interface UserStore {
  readonly mode: "account" | "guest";
  settings: UserSettingsStore;
  files: UserFilesStore;
}
```

Every `namespace` (validated once, at store creation) and `key` (validated on every call) is checked against `@unimatrix/shared`'s `dataNamespaceSchema`/`dataKeySchema` — both adapters throw the same error for the same malformed input, so a service can't accidentally rely on mode-specific validation quirks.

**`getObjectUrl` callers must `URL.revokeObjectURL(url)` when done with it** — the store doesn't track or revoke the URLs it hands out.

## Account vs guest

- **`createAccountUserStore({ namespace, baseUrl, getToken })`** — server-backed. `settings.*` and `files.list`/`files.delete` call `@unimatrix/api-client`'s typed `/me/data`/`/me/files` methods; a `getDocument` 404 is mapped to `undefined` rather than thrown. `files.upload`/`files.getBlob` use a raw `fetch` (`multipart/form-data` POST to `/me/files`, raw bytes `GET` from `/me/files/content`) because those two endpoints aren't JSON contracts — both attach `Authorization: Bearer <token>` from `getToken()` the same way the JSON calls do. `baseUrl` may be a relative same-origin path (e.g. `/api`).
- **`createGuestUserStore({ namespace })`** — browser-only, no network. Backed by one shared IndexedDB database (`unimatrix-user-data`) with `documents` and `files` object stores, both keyed by `[namespace, key]`. Files are stored as native `Blob`s. No auth, no server round-trip.
- **`createUserStore(options)`** — single entry point; pass `{ mode: "account", ... }` or `{ mode: "guest", ... }` and it dispatches to the matching adapter.

Files are SQLite-blob-backed on the server today (see `apps/api`'s `/me/files` implementation) — that's an implementation detail of the account adapter, not something this package's callers need to know, and it's swappable later without changing this package's interface.

## `useUserStore` (React)

```ts
function useUserStore(
  namespace: string,
  options?: { allowGuest?: boolean; baseUrl?: string },
): {
  mode: "account" | "guest" | "unauthenticated";
  store: UserStore | null;
  isReady: boolean;
};
```

- Signed in -> `{ mode: "account", store, isReady: true }` (token from `useAuth().getToken`, the plain session token, no template).
- Signed out, `allowGuest` (default `true`) -> `{ mode: "guest", store, isReady: true }`.
- Signed out, `allowGuest: false` -> `{ mode: "unauthenticated", store: null, isReady: true }`, so the caller can prompt sign-in instead of silently using a guest store.
- While Clerk is still loading -> `{ mode: "unauthenticated", store: null, isReady: false }`.

The store is memoized on the relevant deps (`namespace`, `baseUrl`, `allowGuest`, auth state) — it isn't recreated every render.

### Usage sketch

```tsx
import { useUserStore } from "@unimatrix/user-data/react";

function AvatarSettings() {
  const { mode, store, isReady } = useUserStore("cube-trainer");

  async function saveNickname(nickname: string) {
    await store?.settings.set("nickname", nickname);
  }

  async function uploadAvatar(file: File) {
    await store?.files.upload("avatar.png", file, { contentType: file.type });
  }

  if (!isReady) return null;
  return (
    <p>
      Signed in as: {mode}
      {/* ...form calling saveNickname / uploadAvatar... */}
    </p>
  );
}
```

## Guest -> account migration

```ts
function migrateGuestDataToAccount(args: {
  namespace: string;
  account: UserStore; // must have mode "account"
  guest: UserStore; // must have mode "guest"
  options?: { conflictPolicy?: "skip-existing" | "overwrite"; clearGuestAfter?: boolean };
}): Promise<{
  documentsMigrated: number;
  documentsSkipped: number;
  filesMigrated: number;
  filesSkipped: number;
}>;
```

Copies every guest document and file for `namespace` up to the account store. **Default `conflictPolicy` is `"skip-existing"`** — a key already present on the account is left untouched; pass `"overwrite"` to clobber it instead. `clearGuestAfter` (default `false`) deletes the migrated guest data afterward. It's pure-ish over the two `UserStore` interfaces, so it's testable against fakes without touching a real backend or IndexedDB.

`useGuestDataMigration(namespace, options?)` wraps this for React: it is **opt-in** (never called implicitly by `useUserStore`) — a service mounts it deliberately, typically once near the root of a feature that wants guest data carried over on sign-in:

```tsx
import { useGuestDataMigration, useUserStore } from "@unimatrix/user-data/react";

function CubeTrainerRoot() {
  // Runs migrateGuestDataToAccount exactly once, the first time this
  // component observes a signed-out -> signed-in transition.
  useGuestDataMigration("cube-trainer");

  const { store } = useUserStore("cube-trainer");
  // ...
}
```

It guards against re-running for the lifetime of the mounted component and only fires on an observed sign-out -> sign-in transition (not on initial mount if already signed in).
