import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import {
  deployAttemptIntentSchema,
  deployManualRedeployInputSchema,
  deployRollbackInputSchema,
  type DeployRollbackInput,
  type DeployManualRedeployInput,
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

export interface ManualRedeployReservation {
  attempt: DeployAttemptRecord;
  created: boolean;
}

export interface DeploymentExecutionClaim {
  attempt: DeployAttemptRecord;
  claimed: boolean;
}

export interface DeploymentAttemptStore {
  findRollback(
    input: DeployRollbackInput,
    reporterId: string,
    now: number,
  ): DeployAttemptRecord | undefined;
  reserveRollback(
    input: DeployRollbackInput,
    reporterId: string,
    baseline: DeployAttemptBaseline | null,
    now: number,
  ): ManualRedeployReservation;
  claimExecution(
    app: string,
    attemptId: string,
    reporterId: string,
    now: number,
    baseline: DeployAttemptBaseline,
  ): DeploymentExecutionClaim;
  findManual(
    input: DeployManualRedeployInput,
    reporterId: string,
    now: number,
  ): DeployAttemptRecord | undefined;
  reserveManual(
    input: DeployManualRedeployInput,
    reporterId: string,
    baseline: DeployAttemptBaseline | null,
    now: number,
  ): ManualRedeployReservation;
  intent(
    input: DeployAttemptIntent,
    reporterId: string,
    baseline: DeployAttemptBaseline | null,
    now: number,
  ): DeployAttemptRecord;
  report(input: DeployAttemptReport, reporterId: string, now: number): DeployAttemptRecord;
  observe(evidence: readonly DeployRuntimeEvidence[], now: number): void;
  list(app: string | undefined, limit: number, now: number): DeployAttemptRecord[];
  get(app: string, attemptId: string, now: number): DeployAttemptRecord | undefined;
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
function hasUnresolvedWork(record: DeployAttemptRecord): boolean {
  return (
    record.outcome !== "failed" &&
    record.outcome !== "landed" &&
    record.outcome !== "recreated" &&
    record.recreatedAt == null &&
    record.lateLandedAt === null &&
    (record.outcome !== "timed-out" ||
      record.queue !== null ||
      record.tagWrite === "started" ||
      record.tagWrite === "unknown")
  );
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
        if (record.deadlineAt < now - ATTEMPT_RETENTION_MS && !hasUnresolvedWork(record)) {
          db.prepare("DELETE FROM deployment_attempts WHERE id = ?").run(record.id);
        } else {
          writeRecord(record);
          retained.push(record);
        }
      }
      return retained;
    };
    const manualKey = (input: DeployManualRedeployInput): string =>
      JSON.stringify(["manual", input.actorUserId, input.requestId]);
    const readManual = (
      input: DeployManualRedeployInput,
      reporterId: string,
    ): DeployAttemptRecord | undefined => {
      if (reporterId.length === 0 || reporterId.length > 128) throw conflict();
      const existing = db
        .prepare("SELECT record FROM deployment_attempts WHERE request_key = ?")
        .get(manualKey(input)) as { record: string } | undefined;
      if (existing === undefined) return undefined;
      const attempt = deployAttemptResponseSchema.parse(JSON.parse(existing.record));
      if (attempt.app !== input.app || attempt.reporterId !== reporterId) throw conflict();
      return attempt;
    };
    const readRollback = (
      input: DeployRollbackInput,
      reporterId: string,
    ): DeployAttemptRecord | undefined => {
      if (reporterId.length === 0 || reporterId.length > 128) throw conflict();
      const row = db
        .prepare("SELECT record FROM deployment_attempts WHERE request_key = ?")
        .get(JSON.stringify(["rollback", input.actorUserId, input.requestId])) as
        { record: string } | undefined;
      if (row === undefined) return undefined;
      const attempt = deployAttemptResponseSchema.parse(JSON.parse(row.record));
      if (
        attempt.app !== input.app ||
        attempt.reporterId !== reporterId ||
        attempt.targetAttemptId !== input.targetAttemptId
      )
        throw conflict();
      return attempt;
    };
    return {
      findRollback: db.transaction(
        (input: DeployRollbackInput, reporterId: string, now: number) => {
          const parsed = deployRollbackInputSchema.parse(input);
          maintain(now);
          return readRollback(parsed, reporterId);
        },
      ),
      reserveRollback: db.transaction(
        (
          input: DeployRollbackInput,
          reporterId: string,
          baseline: DeployAttemptBaseline | null,
          now: number,
        ): ManualRedeployReservation => {
          const parsed = deployRollbackInputSchema.parse(input);
          const before = deployAttemptBaselineSchema.nullable().parse(baseline);
          if (before !== null && before.observedAt > now) throw conflict();
          const records = maintain(now);
          const existing = readRollback(parsed, reporterId);
          if (existing !== undefined) return { attempt: existing, created: false };
          const target = records.find(
            (record) => record.id === parsed.targetAttemptId && record.app === parsed.app,
          );
          if (
            target === undefined ||
            target.outcome !== "landed" ||
            target.correlation !== "verified" ||
            target.landedAt === null ||
            target.image === null
          )
            throw conflict();
          if (records.some((record) => record.app === parsed.app && hasUnresolvedWork(record)))
            throw conflict();
          if (records.length >= MAX_ATTEMPT_RECORDS)
            throw Object.assign(new Error("Deployment attempt capacity exhausted."), {
              statusCode: 503,
            });
          const attempt: DeployAttemptRecord = {
            ...parsed,
            repository: target.repository,
            runId: null,
            runAttempt: null,
            trigger: "rollback",
            image: target.image,
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
          db.prepare(
            "INSERT INTO deployment_attempts (id, request_key, requested_at, record) VALUES (?, ?, ?, ?)",
          ).run(
            attempt.id,
            JSON.stringify(["rollback", parsed.actorUserId, parsed.requestId]),
            now,
            JSON.stringify(attempt),
          );
          return { attempt, created: true };
        },
      ),
      claimExecution: db.transaction(
        (
          app: string,
          attemptId: string,
          reporterId: string,
          now: number,
          baseline: DeployAttemptBaseline,
        ) => {
          const attempt = maintain(now).find(
            (record) => record.id === attemptId && record.app === app,
          );
          if (attempt === undefined || attempt.reporterId !== reporterId || attempt.image === null)
            throw conflict();
          if (attempt.tagWrite !== null) return { attempt, claimed: false };
          if (
            now >= attempt.deadlineAt ||
            attempt.outcome !== "incomplete" ||
            attempt.correlation !== "pending"
          )
            throw conflict();
          const before = deployAttemptBaselineSchema.parse(baseline);
          if (before.observedAt > now || now - before.observedAt >= 30_000) throw conflict();
          attempt.baseline = before;
          attempt.tagWrite = "started";
          writeRecord(attempt);
          return { attempt, claimed: true };
        },
      ),
      findManual: db.transaction(
        (input: DeployManualRedeployInput, reporterId: string, now: number) => {
          const parsed = deployManualRedeployInputSchema.parse(input);
          maintain(now);
          return readManual(parsed, reporterId);
        },
      ),
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
            if (
              record.image === null ||
              record.runId === null ||
              record.runAttempt === null ||
              record.trigger !== "ci"
            )
              throw conflict();
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
          if (
            records.some((previous) => previous.app === record.app && hasUnresolvedWork(previous))
          )
            throw conflict();
          db.prepare(
            "INSERT INTO deployment_attempts (id, request_key, requested_at, record) VALUES (?, ?, ?, ?)",
          ).run(record.id, key, now, JSON.stringify(record));
          return record;
        },
      ),
      reserveManual: db.transaction(
        (
          input: DeployManualRedeployInput,
          reporterId: string,
          baseline: DeployAttemptBaseline | null,
          now: number,
        ): ManualRedeployReservation => {
          const parsed = deployManualRedeployInputSchema.parse(input);
          if (reporterId.length === 0 || reporterId.length > 128) throw conflict();
          const before = deployAttemptBaselineSchema.nullable().parse(baseline);
          if (before !== null && before.observedAt > now) throw conflict();
          const records = maintain(now);
          const existing = readManual(parsed, reporterId);
          if (existing !== undefined) return { attempt: existing, created: false };
          if (records.some((record) => record.app === parsed.app && hasUnresolvedWork(record)))
            throw conflict();
          if (records.length >= MAX_ATTEMPT_RECORDS)
            throw Object.assign(new Error("Deployment attempt capacity exhausted."), {
              statusCode: 503,
            });
          const attempt: DeployAttemptRecord = {
            repository: "unimatrixcore/unimatrix-01",
            runId: null,
            runAttempt: null,
            app: parsed.app,
            trigger: "manual",
            image: null,
            recreatedAt: null,
            actorUserId: parsed.actorUserId,
            requestId: parsed.requestId,
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
          db.prepare(
            "INSERT INTO deployment_attempts (id, request_key, requested_at, record) VALUES (?, ?, ?, ?)",
          ).run(attempt.id, manualKey(parsed), now, JSON.stringify(attempt));
          return { attempt, created: true };
        },
      ),
      report: db.transaction((input: DeployAttemptReport, reporterId: string, now: number) => {
        const parsed = deployAttemptReportSchema.parse(input);
        const record = maintain(now).find((entry) => entry.id === parsed.attemptId);
        if (record === undefined)
          throw Object.assign(new Error("Deployment attempt not found."), { statusCode: 404 });
        if (record.reporterId !== reporterId) throw conflict();
        const field = parsed.stage === "tag-write" ? "tagWrite" : "queue";
        if (field === "tagWrite" && record.image === null) throw conflict();
        if (field === "queue" && record.image !== null && record.tagWrite !== "acknowledged")
          throw conflict();
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
      get: db.transaction((app: string, attemptId: string, now: number) =>
        maintain(now).find((record) => record.id === attemptId && record.app === app),
      ),
      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
