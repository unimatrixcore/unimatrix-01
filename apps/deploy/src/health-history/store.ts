import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import {
  DAY_MS,
  HISTORY_RETENTION_MS,
  PROBE_INTERVAL_MS,
  healthObservationSchema,
  summarizeHealth,
  type HealthObservation,
  type HealthSummary,
} from "./model.js";

export interface HealthSnapshot {
  app: string;
  current: { app: string; state: HealthObservation["state"]; checkedAt: number | null };
  summary: HealthSummary;
  days: readonly HealthSummary[];
  recent: readonly HealthObservation[];
}

export interface HealthHistoryStore {
  record(observation: HealthObservation, now: number): void;
  snapshot(app: string, now: number): HealthSnapshot;
  close(): void;
}

/** One row per app per minute bounds even rapid process restarts; old pages are reused by SQLite. */
export function openHealthHistoryStore(
  path: string,
  apps: readonly string[],
  now = Date.now(),
): HealthHistoryStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("journal_size_limit = 1048576");
    db.pragma("busy_timeout = 5000");
    const version = db.pragma("user_version", { simple: true });
    if (version !== 0 && version !== 1)
      throw new Error("Unsupported health history schema version.");
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS health_probes (
        app TEXT NOT NULL,
        bucket INTEGER NOT NULL,
        checked_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('up', 'down', 'unknown')),
        PRIMARY KEY (app, bucket)
      ) WITHOUT ROWID`);
      db.exec("CREATE INDEX IF NOT EXISTS health_probes_time ON health_probes (checked_at)");
      db.pragma("user_version = 1");
    })();
    const appSet = new Set(apps);
    // A restart can observe a change in the same minute. Keep the latest result; the earlier
    // portion becomes unknown instead of attributing it to that replacement result.
    const insert = db.prepare(
      "INSERT INTO health_probes (app, bucket, checked_at, state) VALUES (?, ?, ?, ?) ON CONFLICT(app, bucket) DO UPDATE SET checked_at = excluded.checked_at, state = excluded.state",
    );
    const prune = db.prepare("DELETE FROM health_probes WHERE checked_at < ? OR checked_at > ?");
    prune.run(now - HISTORY_RETENTION_MS - PROBE_INTERVAL_MS, now);
    const read = db.prepare(
      "SELECT app, checked_at AS checkedAt, state FROM health_probes WHERE app = ? AND checked_at >= ? AND checked_at <= ? ORDER BY checked_at",
    );
    const deleteApp = db.prepare("DELETE FROM health_probes WHERE app = ?");
    for (const row of db.prepare("SELECT DISTINCT app FROM health_probes").all()) {
      const app = (row as { app: string }).app;
      if (!appSet.has(app)) deleteApp.run(app);
    }
    const write = db.transaction((observation: HealthObservation, now: number) => {
      prune.run(now - HISTORY_RETENTION_MS - PROBE_INTERVAL_MS, now);
      insert.run(
        observation.app,
        Math.floor(observation.checkedAt / PROBE_INTERVAL_MS),
        observation.checkedAt,
        observation.state,
      );
    });
    return {
      record(observation, now) {
        healthObservationSchema.parse(observation);
        if (!appSet.has(observation.app) || observation.checkedAt !== now) {
          throw new Error(
            "Health history requires a declared app and the current observation time.",
          );
        }
        write(observation, now);
      },
      snapshot(app, now) {
        if (!appSet.has(app) || !Number.isSafeInteger(now) || now < HISTORY_RETENTION_MS) {
          throw new Error("Health history requires a declared app and a valid timestamp.");
        }
        const from = now - HISTORY_RETENTION_MS;
        const observations = read
          .all(app, from - PROBE_INTERVAL_MS, now)
          .map((row) => healthObservationSchema.parse(row));
        const latest = observations.at(-1);
        const current: HealthSnapshot["current"] =
          latest && now - latest.checkedAt < PROBE_INTERVAL_MS
            ? latest
            : { app, state: "unknown", checkedAt: latest?.checkedAt ?? null };
        const today = Math.floor(now / DAY_MS) * DAY_MS;
        const days: HealthSummary[] = [];
        for (let offset = 29; offset >= 0; offset -= 1) {
          const dayStart = today - offset * DAY_MS;
          const dayEnd = Math.min(dayStart + DAY_MS, now);
          days.push(summarizeHealth(observations, dayStart, dayEnd));
        }
        return {
          app,
          current,
          summary: summarizeHealth(observations, from, now),
          days,
          recent: observations.slice(-60),
        };
      },
      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
