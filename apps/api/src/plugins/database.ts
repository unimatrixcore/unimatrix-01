import { createDatabase, migrateDatabase, type DatabaseInstance } from "@unimatrix/db";
import type { FastifyInstance } from "fastify";

/**
 * Creates the SQLite/Drizzle database once per app instance and decorates
 * `app.db` with the Drizzle handle. `createDatabase()` resolves the SQLite
 * file path from `@unimatrix/db`'s own config/env (`DATABASE_URL`, falling
 * back to `packages/db/local/unimatrix.sqlite`) — this plugin does not
 * reinvent path handling.
 *
 * Migrations are applied out-of-band by default (`pnpm db:migrate`, part of
 * `pnpm setup:worktree`). In environments without that step — notably a
 * container backed by a persistent volume — set `DB_MIGRATE_ON_START=true`
 * (`runDatabaseMigrations`) to apply any pending migrations here at startup;
 * `migrateDatabase()` is idempotent, so it is a no-op once the schema is
 * current.
 */
export function setupDatabase(app: FastifyInstance): void {
  const instance: DatabaseInstance = createDatabase();

  if (app.runtimeConfig.runDatabaseMigrations) {
    migrateDatabase(instance);
    app.log.info("Applied database migrations at startup (DB_MIGRATE_ON_START).");
  }

  app.decorate("db", instance.db);

  app.addHook("onClose", () => {
    instance.client.close();
  });
}
