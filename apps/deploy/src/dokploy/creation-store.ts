import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

export interface DokployCreationStore {
  reserve(appDir: string): boolean;
  close(): void;
}

export function openDokployCreationStore(path: string): DokployCreationStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS dokploy_creation_reservations (
      app_dir TEXT PRIMARY KEY NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO dokploy_creation_reservations (app_dir) VALUES (?)",
    );

    return {
      reserve: (appDir) => insert.run(appDir).changes === 1,
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
