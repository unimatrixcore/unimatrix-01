# AGENTS.md

## 1. Overview
`packages/api-client` is the typed transport boundary for the monorepo. It turns shared contracts from `@unimatrix/shared` into fetch-based request helpers without owning server logic or schema definitions.

## 2. Folder Structure
- `src/client.ts`: API client factory, request execution, response parsing, and contract-aware helpers.
- `src/config.ts`: transport-facing config and fetch/response interfaces.
- `src/index.ts`: package barrel for client and config exports.
- `test`: mocked fetch coverage for URL joining, headers, error handling, and contract-specific helpers.

## 3. Core Behaviors & Patterns
- **Factory entrypoint**: `createApiClient(...)` is the package entrypoint. It resolves a fetch implementation, prepares default headers, and returns a small typed client surface.
- **Contract-aware requests**: `request<TContract>(contract, options?)` uses the shared contract's method, path, `bodySchema`/`querySchema`, and `responseSchema.parse(...)` to build and validate requests. `options.body`/`options.query` are only present in the type (and required at the call site) when the contract declares the matching schema — see `ApiClientRequestOptions<TContract>` in `src/client.ts`. New helpers should delegate to `request(...)` instead of bypassing the contract layer.
- **Auth-agnostic token provider**: `ApiClientConfig.getAuthToken` (in `src/config.ts`) is an optional `() => string | null | undefined | Promise<...>` resolved fresh on every request. This package must never import Clerk or any other auth SDK — the consuming app supplies the provider (e.g. apps/web wraps Clerk's `getToken`). A non-empty resolved value attaches `Authorization: Bearer <token>`; anything falsy omits the header.
- **Admin convenience methods**: `listUsers`/`updateUserPermissions` on the returned client are thin typed wrappers that call `request(...)` with the corresponding contract from `@unimatrix/shared` — don't hand-roll fetch calls for new endpoints; add a contract-backed method the same way.
- **Per-user data convenience methods**: `getDocument`/`putDocument`/`deleteDocument`/`listDocuments`/`listFiles`/`deleteFile` follow the same thin-wrapper pattern over the `/me/data` and `/me/files` (metadata) contracts. Binary file upload/download (`multipart/form-data` POST, raw bytes GET) are intentionally **not** JSON contracts and are not wrapped here — `@unimatrix/user-data` handles those with raw `fetch` on top of this client.
- **Transport isolation**: Base URL/querystring joining, fetch resolution, and response parsing live here. Shared schemas stay in `@unimatrix/shared`, and server behavior stays in `apps/api`.
- **Error reporting**: Non-OK responses and non-JSON payloads throw `ApiClientError` (exported from the package), which always carries `status` and best-effort parses the API's `{ error: { code, message, statusCode, details? }, requestId }` envelope onto `code`/`message`/`requestId`/`details`. Keep new transport helpers throwing `ApiClientError` too instead of bare `Error`s or silent failures.

## 4. Conventions
- **Naming**: Use `create*` factories and `ApiClient*` interface names for transport abstractions.
- **Imports**: Consume contracts and types from `@unimatrix/shared`, then keep local transport interfaces in `config.ts`; relative imports use explicit `.js` extensions.
- **Tests**: Mock fetch behavior in `test/client.test.ts` and assert the client against shared contracts rather than hard-coded endpoint strings when possible.

## 5. Working Agreements
- Follow the shared repo working agreements in the root `AGENTS.md`; this file only adds `packages/api-client` structure, patterns, and conventions.
