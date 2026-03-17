# AGENTS.md

## 1. Overview
`packages/shared` is the framework-agnostic contract and schema layer for the monorepo. It defines typed API shapes that apps and client packages reuse without importing each other's runtime code.

## 2. Folder Structure
- `src/contracts`: shared API contract definitions and related contract utilities.
- `src/schemas`: shared Zod schemas and exported schema types.
- `src/index.ts`: package barrel for contracts and schemas.
- `test`: focused contract and schema validation tests.

## 3. Core Behaviors & Patterns
- **Contract-first typing**: Contracts live in `src/contracts` and are defined through helpers such as `defineApiContract(...)`. Consumers derive response types from the contract instead of duplicating them.
- **Schema pairing**: Each shared contract pairs with a Zod schema in `src/schemas`, then exports typed outputs such as `HealthResponse`. Keep schemas and contract types aligned so server and client code validate against the same shape.
- **Framework-agnostic boundary**: Keep this package free of transport code, UI code, and content-loading behavior. It should remain pure TypeScript and Zod so any workspace can consume it.

## 4. Conventions
- **Naming**: Use `*Schema` for Zod schemas, `*Contract` for contract definitions, and descriptive `Api*` prefixes for shared HTTP abstractions.
- **Structure**: Add new shared concerns under `src/contracts` or `src/schemas` with barrel exports, rather than flattening everything into `src/index.ts`.
- **Types**: Prefer exported named types such as `ApiContractResponse<T>` and `HealthResponse` over anonymous inline shapes at package boundaries.

## 5. Working Agreements
- Follow the shared repo working agreements in the root `AGENTS.md`; this file only adds `packages/shared` structure, patterns, and conventions.
