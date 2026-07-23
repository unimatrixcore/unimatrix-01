# AGENTS.md

## 1. Overview
`packages/user-data` is the browser-side per-user data store for the monorepo. A `UserStore` instance is bound to one service/feature `namespace` and exposes an identical `settings`/`files` surface whether it's backed by the server (`"account"` mode, via `@unimatrix/api-client`) or by local IndexedDB (`"guest"` mode, no network, no auth). `./react` adds a hook that picks the right mode from Clerk auth state and an opt-in guest-to-account migration hook.

## 2. Folder Structure
- `src/types.ts`: the `UserSettingsStore`/`UserFilesStore`/`UserStore` interfaces both adapters implement.
- `src/validation.ts`: `assertValidNamespace`/`assertValidKey`, thin wrappers over `@unimatrix/shared`'s `dataNamespaceSchema`/`dataKeySchema`. Both adapters call these so malformed input fails identically regardless of mode.
- `src/account-store.ts`: `createAccountUserStore` — server-backed adapter. JSON ops (`settings.*`, `files.list`/`files.delete`) delegate to `@unimatrix/api-client`'s typed methods; binary upload/download use a raw, injectable `fetch` (`AccountFetch`) since those two endpoints are not JSON contracts.
- `src/guest-store.ts`: `createGuestUserStore` — browser-only, no-network adapter backed by one shared IndexedDB database (`unimatrix-user-data`) with `documents`/`files` object stores keyed by `[namespace, key]`.
- `src/create-user-store.ts`: `createUserStore` — single entry point that dispatches to one adapter or the other based on `options.mode`.
- `src/migration.ts`: `migrateGuestDataToAccount` — copies a namespace's guest documents/files up to the account store. Pure-ish over the two `UserStore` interfaces (no direct IndexedDB/fetch access), so it's unit-testable against fakes.
- `src/index.ts`: the `.` entry barrel — types, both adapters, `createUserStore`, the migration function.
- `src/react.tsx`: the `./react` entry point — `useUserStore` and `useGuestDataMigration`. Browser-only; depends on `@unimatrix/auth/react`.
- `test/`: `migration.test.ts` (fakes, no IndexedDB/fetch), `guest-store.test.ts` (`fake-indexeddb`), `account-store.test.ts` (fake `fetch`).

## 3. Core Behaviors & Patterns
- **Two isolated entry points**: `.` has no React dependency and is safe to import from any browser context; `./react` is the only place that imports `@unimatrix/auth/react`/`react`. Never import `./react` from `.`.
- **Identical semantics across modes**: both adapters validate `namespace` once (at creation) and every `key` (per call) via `src/validation.ts`, and both resolve `undefined` on a missing document/file rather than throwing — the account adapter maps a `getDocument` 404 (`ApiClientError.status === 404`) to `undefined`; the guest adapter's IndexedDB `get` naturally returns `undefined`. Keep any new adapter behavior symmetric the same way.
- **Binary vs JSON split (account adapter)**: `settings.*` and `files.list`/`files.delete` go through `@unimatrix/api-client`'s typed methods (`getDocument`/`putDocument`/`deleteDocument`/`listDocuments`/`listFiles`/`deleteFile`). `files.upload`/`files.getBlob` use a raw, injectable `AccountFetch` (a `fetch`-shaped function restricted to the subset of `Request`/`Response` this package needs) because `/me/files` (POST) and `/me/files/content` (GET) are not JSON contracts. Both paths share one `getToken`/`baseUrl` and build the bearer header the same way (`Authorization: Bearer <token>`, omitted when `getToken()` resolves falsy).
- **IndexedDB shape (guest adapter)**: one database, `unimatrix-user-data`; two object stores, `documents` and `files`, both `keyPath: ["namespace", "key"]` with a non-unique `byNamespace` index for `list()`. Files are stored as native `Blob`s (IndexedDB supports this directly) alongside their `UserFileMetadata` fields. The database connection is a module-level singleton (`getDatabase()`), shared by every guest store instance in the page regardless of namespace — don't reintroduce a per-instance connection.
- **Migration default is non-destructive**: `migrateGuestDataToAccount`'s `conflictPolicy` defaults to `"skip-existing"` — it never overwrites a document/file key already present on the account. Pass `{ conflictPolicy: "overwrite" }` to change that. `clearGuestAfter` defaults to `false`.
- **`./react` never conditionally calls hooks**: `useUserStore`/`useGuestDataMigration` both call `useAuth()` unconditionally and branch on its `isLoaded`/`isSignedIn` result afterward — never gate the `useAuth()` call itself behind a condition.
- **`useGuestDataMigration` is opt-in and runs once per mount**: it is never called implicitly by `useUserStore`; a service calls it deliberately, once, and it guards against re-running (a signed-out -> signed-in transition tracked via refs) for the lifetime of the component.

## 4. Conventions
- **Naming**: `create*` factories for adapters/the dispatcher, `assert*` for validation helpers that throw, `use*` for the two React hooks, `migrate*` for the migration function.
- **Imports**: consume `@unimatrix/shared` for `dataNamespaceSchema`/`dataKeySchema`/`UserFileMetadata`, `@unimatrix/api-client` for the account adapter's JSON transport, `@unimatrix/auth/react` only from `src/react.tsx`. Relative imports use explicit `.js` extensions.
- **DOM types are allowed here** (unlike `@unimatrix/api-client`): this package's `tsconfig.json` includes `"DOM"`/`"DOM.Iterable"` in `lib` because the guest adapter needs IndexedDB and both adapters use `Blob`/`FormData`/`URL`/`fetch`.
- **Tests**: `migration.test.ts` uses hand-rolled in-memory fakes (no real IndexedDB/fetch) so it stays fast and isolates the pure migration logic; `guest-store.test.ts` uses `fake-indexeddb/auto` (installed globally via `test/setup.ts`); `account-store.test.ts` injects a fake `AccountFetch` — don't hit a live Clerk/backend from any test here.

## 5. Working Agreements
- Follow the shared repo working agreements in the root `AGENTS.md`; this file only adds `packages/user-data` structure, patterns, and conventions.
