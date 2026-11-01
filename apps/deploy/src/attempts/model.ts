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
    record.completedAt ??= record.deadlineAt;
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
    record.queueClaimedAt === null ||
    evidence.observedAt < record.queueClaimedAt ||
    record.outcome === "failed" ||
    record.outcome === "landed" ||
    record.outcome === "already-current" ||
    record.outcome === "recreated" ||
    record.recreatedAt != null ||
    record.lateLandedAt !== null ||
    record.correlation === "ambiguous" ||
    record.queue === null ||
    record.queue === "started" ||
    record.queue === "rejected" ||
    (record.image !== null &&
      (record.image.repository !== evidence.image.repository ||
        record.image.platform !== evidence.image.platform ||
        record.image.digestKind !== evidence.image.digestKind ||
        record.image.digest !== evidence.image.digest))
  )
    return;

  record.after = {
    containerId: evidence.containerId,
    observedAt: evidence.observedAt,
    image: evidence.image,
  };
  if (record.image === null) {
    record.recreatedAt = evidence.observedAt;
    record.outcome =
      record.outcome === "timed-out" || evidence.observedAt >= record.deadlineAt
        ? "timed-out"
        : "recreated";
    record.completedAt ??= record.outcome === "timed-out" ? record.deadlineAt : evidence.observedAt;
    return;
  }
  record.correlation = "verified";
  if (record.outcome === "timed-out" || evidence.observedAt >= record.deadlineAt) {
    record.outcome = "timed-out";
    record.lateLandedAt ??= evidence.observedAt;
    record.completedAt ??= record.deadlineAt;
  } else {
    record.outcome = "landed";
    record.landedAt = evidence.observedAt;
    record.completedAt = evidence.observedAt;
  }
}

export function describeAttemptFailure(
  record: DeployAttemptRecord,
): DeployAttemptRecord["failureReason"] {
  if (record.lateLandedAt !== null || record.outcome === "landed" || record.outcome === "recreated")
    return null;
  if (record.tagWrite === "rejected")
    return "Image tag update was rejected. No deployment was queued.";
  if (record.queue === "rejected") return "Dokploy rejected the deployment queue request.";
  if (record.tagWrite === "unknown")
    return "Image tag update has an unknown result. Resolve the pending operation before retrying.";
  if (record.queue === "unknown")
    return "Deployment queue has an unknown result. Resolve the pending operation before retrying.";
  if (record.outcome !== "timed-out") return null;
  if (record.baseline === null)
    return "No fresh baseline container was recorded; replacement cannot be verified.";
  if (record.correlation === "ambiguous")
    return "Runtime image correlation is ambiguous; deployment cannot be verified.";
  return "The deployment deadline passed without a verified replacement container.";
}
