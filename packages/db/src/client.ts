import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";

import {
  resolveDatabaseConfig,
  type DatabaseConfig,
} from "./config.js";
import * as schema from "./schema/index.js";

export interface DatabaseInstance {
  config: DatabaseConfig;
  client: BetterSqlite3.Database;
  db: BetterSQLite3Database<typeof schema>;
}

export function createSqliteClient(
  overrides: Partial<DatabaseConfig> = {},
): BetterSqlite3.Database {
  const config = resolveDatabaseConfig(overrides);

  if (config.filePath !== ":memory:") {
    mkdirSync(dirname(config.filePath), {
      recursive: true,
    });
  }

  const client = new BetterSqlite3(config.filePath);

  client.pragma("foreign_keys = ON");
  client.pragma("journal_mode = WAL");

  return client;
}

export function createDatabase(
  overrides: Partial<DatabaseConfig> = {},
): DatabaseInstance {
  const config = resolveDatabaseConfig(overrides);
  const client = createSqliteClient(config);
  const db = drizzle({ client, schema });

  return {
    config,
    client,
    db,
  };
}