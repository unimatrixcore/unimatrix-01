import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import type { DatabaseInstance } from "./client.js";

/**
 * Location of the checked-in Drizzle migration files. Resolves to
 * `packages/db/drizzle` from the built output (`dist/migrate.js`), from the
 * TypeScript source, and — because the package ships `drizzle` alongside
 * `dist` (see its `files` field) — from an installed
 * `node_modules/@unimatrix/db` copy, so it works the same in local dev and in
 * a production container.
 */
export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

export interface MigrateDatabaseOptions {
  /** Override the migrations directory (defaults to {@link DEFAULT_MIGRATIONS_FOLDER}). */
  migrationsFolder?: string;
}

/**
 * Applies any pending Drizzle migrations to `instance`. Idempotent — Drizzle
 * records applied migrations in the database, so this is a no-op once the
 * schema is up to date, making it safe to call on every startup (for example
 * a container boot backed by a persistent volume).
 */
export function migrateDatabase(
  instance: Pick<DatabaseInstance, "db">,
  options: MigrateDatabaseOptions = {},
): void {
  migrate(instance.db, {
    migrationsFolder: options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER,
  });
}
