# AGENTS.md

## 1. Overview
`apps/api` is the Fastify API workspace for Unimatrix. It keeps runtime configuration, core HTTP plumbing, and route modules thin while reusing shared contracts and schemas from `@unimatrix/shared`.

## 2. Folder Structure
- `src/app.ts`: Fastify construction, runtime config decoration, and global error and not-found handlers.
- `src/server.ts`: process startup, signal handling, and server listen/shutdown flow.
- `src/config.ts` and `src/env.ts`: runtime config loading and local env-file support.
- `src/plugins`: cross-cutting Fastify setup for validation, observability, security, and CORS.
- `src/modules`: route modules grouped by feature; `index.ts` registers the active modules.
- `src/lib/http`: shared HTTP-layer helpers such as logging, validation, and error normalization.
- `test`: Node test runner coverage for app construction, config, and env loading.

## 3. Core Behaviors & Patterns
- **App wiring**: `buildApp()` in `src/app.ts` creates the Fastify instance, decorates `runtimeConfig`, installs core plugins, and centralizes error and not-found handling before modules are registered.
- **Plugin-first cross-cutting setup**: `src/plugins/index.ts` is the single assembly point for validation, observability, security, and CORS. Add new cross-cutting HTTP behavior there instead of scattering setup across route modules.
- **Contract-driven routes**: Route modules import contracts and Zod schemas from `@unimatrix/shared`, then register handlers through `app.withTypeProvider<ZodTypeProvider>().route(...)`. Response schemas and query validation live with the shared contract definitions, not ad hoc in handlers.
- **Normalized error envelopes**: `src/lib/http/errors.ts` converts validation errors, custom API errors, Fastify client errors, and unexpected failures into a consistent envelope plus log level. Keep new handler code compatible with that normalization path instead of formatting responses inline.
- **Module boundary**: `src/modules/*/index.ts` exports `FastifyPluginAsync` modules, and `src/modules/index.ts` owns registration. Keep handlers inside feature modules and avoid growing `app.ts` into a route registry.

## 4. Conventions
- **Naming**: Use `setup*`, `register*`, `load*`, and `build*` verbs for framework assembly helpers. Shared API types use `Api*` prefixes, and route modules export `*Module`.
- **Imports**: Use external packages first, then workspace packages like `@unimatrix/shared`, then relative imports. Relative ESM imports keep the explicit `.js` extension.
- **Structure**: Put reusable HTTP helpers under `src/lib/http`, cross-cutting Fastify bootstrapping under `src/plugins`, and feature routes under `src/modules/<feature>`.
- **Types**: Prefer explicit exported interfaces and type aliases such as `ApiRuntimeConfig`, `ApiErrorEnvelope`, and `HealthResponse` instead of inferred anonymous shapes at module boundaries.

## 5. Working Agreements
- Follow the shared repo working agreements in the root `AGENTS.md`; this file only adds `apps/api` structure, patterns, and conventions.
