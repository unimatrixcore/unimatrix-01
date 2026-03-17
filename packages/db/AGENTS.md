# AGENTS.md

## 1. Overview
`packages/db` is the monorepo's persistence boundary. It keeps the current SQLite + Drizzle baseline small so later database work can extend the schema without moving the package boundary.

## 2. Folder Structure
- `src/config.ts`: database path resolution and runtime config helpers.
- `src/client.ts`: SQLite client creation, Drizzle database creation, and pragma setup.
- `src/schema`: schema tables and the schema barrel export.
- `src/index.ts`: package barrel for config, client, and schema exports.
- `drizzle.config.ts`: Drizzle Kit configuration pointing at the schema barrel and migration output directory.
- `drizzle`: generated migration SQL and metadata.
- `local`: default local SQLite file location.
- `test`: config and client coverage, including in-memory and temp-file flows.

## 3. Core Behaviors & Patterns
- **Config-driven client creation**: `resolveDatabaseConfig(...)` shapes the database path, and `createSqliteClient(...)` plus `createDatabase(...)` build the raw SQLite and Drizzle clients from that config.
- **SQLite baseline setup**: Client creation ensures parent directories exist and enables `foreign_keys` plus `journal_mode = WAL` before the client is returned. New connection helpers should preserve that baseline behavior.
- **Schema barrel**: Tables live under `src/schema` and are re-exported through `src/schema/index.ts`. Drizzle config and client creation both point at that shared barrel, so new tables should be added there instead of importing individual files ad hoc.
- **Test posture**: Tests prefer `:memory:` databases or temporary filesystem paths, keeping persistence checks isolated from the default local database file.

## 4. Conventions
- **Naming**: Use `create*` for client factories, `resolve*` for config helpers, and `*Table` suffixes for Drizzle table exports such as `systemSettingsTable`.
- **Schema style**: SQLite table names and column names stay snake_case at the database layer, while exported TypeScript types stay `PascalCase`.
- **Boundaries**: Keep route logic, UI concerns, and product-specific business workflows out of this package unless the persistence boundary is intentionally widened.

## 5. Working Agreements
- Follow the shared repo working agreements in the root `AGENTS.md`; this file only adds `packages/db` structure, patterns, and conventions.
