import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import {
  deployAttemptIntentSchema,
  deployAttemptReportSchema,
  deployAttemptResponseSchema,
  deployAttemptBaselineSchema,
  deployRuntimeEvidenceSchema,
  type DeployAttemptIntent,
  type DeployAttemptReport,
  type DeployAttemptRecord,
  type DeployAttemptBaseline,
  type DeployRuntimeEvidence,
} from "@unimatrix/shared";

import {
  ATTEMPT_DEADLINE_MS,
  ATTEMPT_RETENTION_MS,
  MAX_ATTEMPT_RECORDS,
  expireAttempt,
  applyRuntimeEvidence,
} from "./model.js";

export interface DeploymentAttemptStore {
  intent(
    input: DeployAttemptIntent,
    reporterId: string,
    baseline: DeployAttemptBaseline | null,
    now: number,
  ): DeployAttemptRecord;
  report(input: DeployAttemptReport, reporterId: string, now: number): DeployAttemptRecord;
  observe(evidence: readonly DeployRuntimeEvidence[], now: number): void;
  list(app: string | undefined, limit: number, now: number): DeployAttemptRecord[];
  close(): void;
}

function conflict(): Error {
  return Object.assign(new Error("Deployment attempt conflicts with its durable record."), {
    statusCode: 409,
  });
}
function validateTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + ATTEMPT_DEADLINE_MS)) {
    throw new Error("Invalid deployment observation time.");
  }
}
function canExplainTransition(record: DeployAttemptRecord): boolean {
  return record.outcome !== "failed" && record.outcome !== "landed" && record.lateLandedAt === null;
}

export function openDeploymentAttemptStore(path: string): DeploymentAttemptStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("journal_size_limit = 1048576");
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS deployment_attempts (
      id TEXT PRIMARY KEY NOT NULL,
      request_key TEXT UNIQUE NOT NULL,
      requested_at INTEGER NOT NULL,
      record TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS deployment_attempts_time ON deployment_attempts(requested_at)`);
    const save = db.prepare("UPDATE deployment_attempts SET record = ? WHERE id = ?");
    const all = db.prepare("SELECT record FROM deployment_attempts ORDER BY requested_at, rowid");
    const readRecords = (): DeployAttemptRecord[] =>
      all.all().map((row) => {
        const value = row as { record: string };
        return deployAttemptResponseSchema.parse(JSON.parse(value.record));
      });
    const writeRecord = (record: DeployAttemptRecord): void => {
      save.run(JSON.stringify(record), record.id);
    };
    const maintain = (now: number): DeployAttemptRecord[] => {
      validateTime(now);
      const records = readRecords();
      const retained: DeployAttemptRecord[] = [];
      for (const record of records) {
        expireAttempt(record, now);
        if (record.deadlineAt < now - ATTEMPT_RETENTION_MS) {
          db.prepare("DELETE FROM deployment_attempts WHERE id = ?").run(record.id);
        } else {
          writeRecord(record);
          retained.push(record);
        }
      }
      return retained;
    };
    return {
      intent: db.transaction(
        (
          input: DeployAttemptIntent,
          reporterId: string,
          baseline: DeployAttemptBaseline | null,
          now: number,
        ) => {
          const parsed = deployAttemptIntentSchema.parse(input);
          if (reporterId.length === 0 || reporterId.length > 128) throw conflict();
          const before = deployAttemptBaselineSchema.nullable().parse(baseline);
          if (before !== null && before.observedAt > now) throw conflict();
          const records = maintain(now);
          const key = JSON.stringify([
            parsed.repository,
            parsed.runId,
            parsed.runAttempt,
            parsed.app,
          ]);
          const existing = db
            .prepare("SELECT record FROM deployment_attempts WHERE request_key = ?")
            .get(key) as { record: string } | undefined;
          if (existing !== undefined) {
            const record = deployAttemptResponseSchema.parse(JSON.parse(existing.record));
            const priorIntent: DeployAttemptIntent = {
              repository: record.repository,
              runId: record.runId,
              runAttempt: record.runAttempt,
              app: record.app,
              trigger: record.trigger,
              image: record.image,
            };
            if (
              record.reporterId !== reporterId ||
              JSON.stringify(priorIntent) !== JSON.stringify(parsed)
            )
              throw conflict();
            return record;
          }
          if (records.length >= MAX_ATTEMPT_RECORDS) {
            throw Object.assign(new Error("Deployment attempt capacity exhausted."), {
              statusCode: 503,
            });
          }
          const record: DeployAttemptRecord = {
            ...parsed,
            id: randomUUID(),
            reporterId,
            requestedAt: now,
            deadlineAt: now + ATTEMPT_DEADLINE_MS,
            baseline: before,
            tagWrite: null,
            queue: null,
            queueClaimedAt: null,
            outcome: "incomplete",
            correlation: "pending",
            after: null,
            landedAt: null,
            lateLandedAt: null,
          };
          // Unresolved requests for the same app can explain a later recreation even after
          // their deadline: timeout does not cancel Dokploy's queued work.
          for (const previous of records) {
            if (previous.app === record.app && canExplainTransition(previous)) {
              previous.correlation = "ambiguous";
              record.correlation = "ambiguous";
              writeRecord(previous);
            }
          }
          db.prepare(
            "INSERT INTO deployment_attempts (id, request_key, requested_at, record) VALUES (?, ?, ?, ?)",
          ).run(record.id, key, now, JSON.stringify(record));
          return record;
        },
      ),
      report: db.transaction((input: DeployAttemptReport, reporterId: string, now: number) => {
        const parsed = deployAttemptReportSchema.parse(input);
        const record = maintain(now).find((entry) => entry.id === parsed.attemptId);
        if (record === undefined)
          throw Object.assign(new Error("Deployment attempt not found."), { statusCode: 404 });
        if (record.reporterId !== reporterId) throw conflict();
        const field = parsed.stage === "tag-write" ? "tagWrite" : "queue";
        if (field === "queue" && record.tagWrite !== "acknowledged") throw conflict();
        if (parsed.result === "started") {
          if (record[field] !== null || now >= record.deadlineAt) throw conflict();
          if (field === "queue") record.queueClaimedAt = now;
        } else if (record[field] !== "started" && record[field] !== parsed.result) {
          throw conflict();
        }
        record[field] = parsed.result;
        if (record.outcome === "incomplete" || record.outcome === "queued") {
          if (parsed.result === "rejected") record.outcome = "failed";
          else if (field === "queue" && parsed.result === "acknowledged") record.outcome = "queued";
        }
        writeRecord(record);
        return record;
      }),
      observe: db.transaction((evidence: readonly DeployRuntimeEvidence[], now: number) => {
        const parsed = evidence.map((entry) => deployRuntimeEvidenceSchema.parse(entry));
        const records = maintain(now);
        for (const record of records) {
          for (const observation of parsed) {
            if (observation.observedAt > now) throw conflict();
            applyRuntimeEvidence(record, observation);
          }
          writeRecord(record);
        }
      }),
      list: db.transaction((app: string | undefined, limit: number, now: number) => {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
          throw new Error("Invalid deployment history limit.");
        return maintain(now)
          .filter((record) => app === undefined || record.app === app)
          .reverse()
          .slice(0, limit);
      }),
      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
