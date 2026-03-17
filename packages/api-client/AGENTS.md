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
- **Contract-aware requests**: `request<TContract>()` uses the shared contract's method, path, and `responseSchema.parse(...)` call to validate responses. New helpers should delegate to `request(...)` instead of bypassing the contract layer.
- **Transport isolation**: Base URL joining, fetch resolution, and response parsing live here. Shared schemas stay in `@unimatrix/shared`, and server behavior stays in `apps/api`.
- **Error reporting**: Non-OK responses and non-JSON payloads throw descriptive errors tied to the contract method and path. Keep new transport helpers equally explicit instead of returning silent failures.

## 4. Conventions
- **Naming**: Use `create*` factories and `ApiClient*` interface names for transport abstractions.
- **Imports**: Consume contracts and types from `@unimatrix/shared`, then keep local transport interfaces in `config.ts`; relative imports use explicit `.js` extensions.
- **Tests**: Mock fetch behavior in `test/client.test.ts` and assert the client against shared contracts rather than hard-coded endpoint strings when possible.

## 5. Working Agreements
- Follow the shared repo working agreements in the root `AGENTS.md`; this file only adds `packages/api-client` structure, patterns, and conventions.
