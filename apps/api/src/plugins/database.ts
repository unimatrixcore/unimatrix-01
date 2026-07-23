import { createDatabase, type DatabaseInstance } from "@unimatrix/db";
import type { FastifyInstance } from "fastify";

/**
 * Creates the SQLite/Drizzle database once per app instance and decorates
 * `app.db` with the Drizzle handle. `createDatabase()` resolves the SQLite
 * file path from `@unimatrix/db`'s own config/env (`DATABASE_URL`, falling
 * back to `packages/db/local/unimatrix.sqlite`) — this plugin does not
 * reinvent path handling.
 *
 * This plugin does NOT run migrations at startup: migrations are applied
 * out-of-band via `pnpm db:migrate` (part of `pnpm setup:worktree`), keeping
 * `@unimatrix/db`'s migration workflow as the single place schema changes
 * are applied, consistent with its README/AGENTS.md.
 */
export function setupDatabase(app: FastifyInstance): void {
  const { client, db }: DatabaseInstance = createDatabase();

  app.decorate("db", db);

  app.addHook("onClose", () => {
    client.close();
  });
}
