import type { DeployAttemptRecord, DeployRuntimeEvidence } from "@unimatrix/shared";

export const ATTEMPT_DEADLINE_MS = 30 * 60_000;
export const ATTEMPT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const MAX_ATTEMPT_RECORDS = 10_000;

export function expireAttempt(record: DeployAttemptRecord, now: number): void {
  if (
    (record.outcome === "incomplete" || record.outcome === "queued") &&
    now >= record.deadlineAt
  ) {
    record.outcome = "timed-out";
  }
}

export function applyRuntimeEvidence(
  record: DeployAttemptRecord,
  evidence: DeployRuntimeEvidence,
): void {
  if (
    record.app !== evidence.app ||
    record.baseline === null ||
    record.baseline.containerId === evidence.containerId ||
    evidence.observedAt < record.requestedAt ||
    evidence.observedAt < record.baseline.observedAt ||
    record.outcome === "failed" ||
    record.outcome === "landed" ||
    record.lateLandedAt !== null ||
    record.correlation === "ambiguous" ||
    record.queue === null ||
    record.queue === "started" ||
    record.queue === "rejected" ||
    record.image.repository !== evidence.image.repository ||
    record.image.platform !== evidence.image.platform ||
    record.image.digestKind !== evidence.image.digestKind ||
    record.image.digest !== evidence.image.digest
  )
    return;

  record.after = {
    containerId: evidence.containerId,
    observedAt: evidence.observedAt,
    image: evidence.image,
  };
  record.correlation = "verified";
  if (record.outcome === "timed-out" || evidence.observedAt >= record.deadlineAt) {
    record.outcome = "timed-out";
    record.lateLandedAt ??= evidence.observedAt;
  } else {
    record.outcome = "landed";
    record.landedAt = evidence.observedAt;
  }
}
