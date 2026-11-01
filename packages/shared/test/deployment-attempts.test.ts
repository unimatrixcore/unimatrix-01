import { describe, expect, it } from "vitest";
import {
  deployAttemptIntentSchema,
  hasUnresolvedDeploymentWork,
  deployAttemptReportSchema,
  deployAttemptQuerySchema,
  deployAttemptIntentContract,
  deployAttemptReportContract,
  deployAttemptHistoryContract,
  deployRuntimeEvidenceSchema,
  deployAttemptLogsQuerySchema,
  deployAttemptLogsResponseSchema,
  deployAttemptLogsContract,
  adminDeployAttemptLogsContract,
  deployManualRedeployRequestSchema,
  deployManualRedeployInputSchema,
  deployManualRedeployContract,
  adminDeployManualRedeployContract,
  deployAttemptResponseSchema,
  deployRollbackRequestSchema,
  deployRollbackInputSchema,
  deployExecuteInputSchema,
  deployRollbackContract,
  deployExecuteContract,
  adminDeployRollbackContract,
} from "../src/index.js";

const intent = {
  repository: "unimatrixcore/unimatrix-01",
  runId: "123",
  runAttempt: 1,
  app: "api",
  trigger: "ci",
  image: {
    repository: "ghcr.io/unimatrixcore/unimatrix-api",
    tag: "main",
    commit: "a".repeat(40),
    platform: "linux/amd64",
    digestKind: "manifest",
    digest: `sha256:${"b".repeat(64)}`,
  },
};
describe("deployment attempt contracts", () => {
  it("accepts bounded public commit subjects and rejects controls or arbitrary diagnostic output", () => {
    expect(
      deployAttemptIntentSchema.parse({ ...intent, commitSubject: "feat: deploy console" })
        .commitSubject,
    ).toBe("feat: deploy console");
    for (const commitSubject of ["", "a".repeat(241), "line\nline", "secret\u001b[0m"]) {
      expect(deployAttemptIntentSchema.safeParse({ ...intent, commitSubject }).success).toBe(false);
    }
    const output = {
      app: "api",
      attemptId: "00000000-0000-4000-8000-000000000000",
      policy: "recognized-events-only",
      status: "unavailable",
      reason: "unassociated",
      diagnosticLines: ["▶ Deployment attempt accepted and recorded."],
    };
    expect(deployAttemptLogsResponseSchema.safeParse(output).success).toBe(true);
    expect(
      deployAttemptLogsResponseSchema.safeParse({ ...output, diagnosticLines: ["private-secret"] })
        .success,
    ).toBe(false);
    expect(
      deployAttemptLogsResponseSchema.safeParse({
        ...output,
        diagnosticLines: ["Requested image already running; no deployment was queued."],
      }).success,
    ).toBe(true);
    expect(
      deployAttemptLogsResponseSchema.safeParse({
        ...output,
        diagnosticLines: Array.from(
          { length: 21 },
          () => "▶ Deployment attempt accepted and recorded.",
        ),
      }).success,
    ).toBe(false);
  });
  it("requires exact log selection and only bounded recognized event output", () => {
    const query = { app: "api", attemptId: "00000000-0000-4000-8000-000000000000" };
    expect(deployAttemptLogsQuerySchema.parse(query)).toEqual(query);
    expect(deployAttemptLogsContract.path).toBe("/deployment/attempts/logs");
    expect(adminDeployAttemptLogsContract.path).toBe("/deployment/admin/attempts/logs");
    for (const invalid of [
      { app: "api" },
      { ...query, app: "../private" },
      { ...query, tail: 1 },
    ]) {
      expect(deployAttemptLogsQuerySchema.safeParse(invalid).success).toBe(false);
    }
    const output = {
      ...query,
      policy: "recognized-events-only",
      status: "available",
      events: ["deployment-initialized", "deployment-failed"],
      withheld: true,
      truncated: false,
    };
    expect(deployAttemptLogsResponseSchema.parse(output)).toEqual(output);
    for (const invalid of [
      { ...output, text: "private credential" },
      { ...output, events: ["private credential"] },
      { ...output, events: Array.from({ length: 101 }, () => "deployment-failed") },
    ]) {
      expect(deployAttemptLogsResponseSchema.safeParse(invalid).success).toBe(false);
    }
    for (const reason of ["unassociated", "source-unavailable", "ambiguous"]) {
      const unavailable = {
        ...query,
        policy: "recognized-events-only",
        status: "unavailable",
        reason,
      };
      expect(deployAttemptLogsResponseSchema.parse(unavailable)).toEqual(unavailable);
    }
  });
  it("uses static bounded mutation and history contracts", () => {
    expect(deployAttemptIntentContract.path).toBe("/deployment/attempts/intent");
    expect(deployAttemptReportContract.method).toBe("POST");
    expect(deployAttemptHistoryContract.method).toBe("GET");
    expect(deployAttemptQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(deployAttemptQuerySchema.parse({ limit: "100" })).toEqual({ limit: 100 });
    expect(deployAttemptQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
  it("accepts immutable publication identity but refuses untrusted verdicts, reporter identity and raw values", () => {
    expect(deployAttemptIntentSchema.parse(intent)).toEqual(intent);
    for (const field of ["reporterId", "landed", "env", "log"]) {
      expect(deployAttemptIntentSchema.safeParse({ ...intent, [field]: "value" }).success).toBe(
        false,
      );
    }
    expect(
      deployAttemptIntentSchema.safeParse({
        ...intent,
        image: { ...intent.image, digestKind: "index" },
      }).success,
    ).toBe(false);
    expect(
      deployAttemptReportSchema.safeParse({
        attemptId: "00000000-0000-4000-8000-000000000000",
        stage: "queue",
        result: "landed",
      }).success,
    ).toBe(false);
  });
  it("requires full container IDs and a manifest digest tied to a platform", () => {
    const sample = {
      app: "api",
      containerId: "c".repeat(64),
      observedAt: 1,
      image: {
        repository: intent.image.repository,
        platform: "linux/amd64",
        digestKind: "manifest",
        digest: intent.image.digest,
      },
    };
    expect(deployRuntimeEvidenceSchema.safeParse(sample).success).toBe(true);
    expect(deployRuntimeEvidenceSchema.safeParse({ ...sample, containerId: "abcd" }).success).toBe(
      false,
    );
    expect(
      deployRuntimeEvidenceSchema.safeParse({
        ...sample,
        image: { ...sample.image, digest: "sha256:config-id" },
      }).success,
    ).toBe(false);
  });
});

it("manual redeploy contracts separate verified actor attribution from browser input", () => {
  const request = { app: "api", requestId: "00000000-0000-4000-8000-000000000001" };
  expect(deployManualRedeployRequestSchema.parse(request)).toEqual(request);
  expect(
    deployManualRedeployRequestSchema.safeParse({ ...request, actorUserId: "spoofed" }).success,
  ).toBe(false);
  expect(
    deployManualRedeployRequestSchema.safeParse({ ...request, composeId: "foreign" }).success,
  ).toBe(false);
  expect(deployManualRedeployInputSchema.safeParse(request).success).toBe(false);
  expect(
    deployManualRedeployInputSchema.parse({ ...request, actorUserId: "verified" }).actorUserId,
  ).toBe("verified");
  expect(deployManualRedeployContract.path).toBe("/deployment/redeploy");
  expect(adminDeployManualRedeployContract.path).toBe("/deployment/admin/redeploy");
  expect(deployManualRedeployContract.method).toBe("POST");
});

it("rollback selects recorded provenance instead of caller-supplied images or actor identity", () => {
  const request = {
    app: "api",
    requestId: "00000000-0000-4000-8000-000000000001",
    targetAttemptId: "00000000-0000-4000-8000-000000000002",
  };
  expect(deployRollbackRequestSchema.parse(request)).toEqual(request);
  for (const invalid of [
    { ...request, actorUserId: "spoofed" },
    { ...request, image: intent.image },
    { ...request, targetAttemptId: "arbitrary-tag" },
  ]) {
    expect(deployRollbackRequestSchema.safeParse(invalid).success).toBe(false);
  }
  expect(deployRollbackInputSchema.safeParse(request).success).toBe(false);
  expect(deployRollbackInputSchema.parse({ ...request, actorUserId: "verified" }).actorUserId).toBe(
    "verified",
  );
  expect(deployRollbackContract.path).toBe("/deployment/rollback");
  expect(adminDeployRollbackContract.path).toBe("/deployment/admin/rollback");
  expect(deployExecuteContract.path).toBe("/deployment/execute");
  const execute = { app: "api", attemptId: request.targetAttemptId };
  expect(deployExecuteInputSchema.parse(execute)).toEqual(execute);
  expect(deployExecuteInputSchema.safeParse({ ...execute, image: intent.image }).success).toBe(
    false,
  );
  for (const trigger of ["manual", "rollback"]) {
    expect(deployAttemptIntentSchema.safeParse({ ...intent, trigger }).success).toBe(false);
  }
});

it("rollback attempts retain target provenance and verified actor without fictitious CI identity", () => {
  const record = {
    ...intent,
    runId: null,
    runAttempt: null,
    trigger: "rollback",
    targetAttemptId: "00000000-0000-4000-8000-000000000001",
    actorUserId: "verified",
    requestId: "00000000-0000-4000-8000-000000000002",
    id: "00000000-0000-4000-8000-000000000003",
    reporterId: "api-service",
    requestedAt: 1,
    deadlineAt: 100,
    baseline: null,
    tagWrite: "acknowledged",
    queue: "acknowledged",
    queueClaimedAt: 1,
    outcome: "queued",
    correlation: "pending",
    after: null,
    landedAt: null,
    lateLandedAt: null,
  };
  expect(deployAttemptResponseSchema.parse(record)).toEqual(record);
  for (const invalid of [
    { ...record, runId: "123" },
    { ...record, runAttempt: 1 },
    { ...record, actorUserId: undefined },
    { ...record, requestId: undefined },
    { ...record, targetAttemptId: undefined },
    { ...record, trigger: "ci" },
    { ...record, image: null },
  ]) {
    expect(deployAttemptResponseSchema.safeParse(invalid).success).toBe(false);
  }
});

it("reads legacy image-bearing manual and rollback records without reopening their intent ingress", () => {
  const record = {
    ...intent,
    id: "00000000-0000-4000-8000-000000000001",
    reporterId: "legacy-ci-service",
    requestedAt: 1,
    deadlineAt: 100,
    baseline: null,
    tagWrite: "acknowledged",
    queue: "acknowledged",
    queueClaimedAt: 1,
    outcome: "queued",
    correlation: "pending",
    after: null,
    landedAt: null,
    lateLandedAt: null,
  };
  for (const trigger of ["manual", "rollback"]) {
    expect(deployAttemptResponseSchema.parse({ ...record, trigger })).toEqual({
      ...record,
      trigger,
    });
    expect(deployAttemptIntentSchema.safeParse({ ...intent, trigger }).success).toBe(false);
    expect(
      deployAttemptResponseSchema.safeParse({ ...record, trigger, actorUserId: "mixed" }).success,
    ).toBe(false);
    expect(deployAttemptResponseSchema.safeParse({ ...record, trigger, runId: null }).success).toBe(
      false,
    );
  }
});

it("unspecified manual targets cannot carry fictitious CI identity or verified landing", () => {
  const record = {
    ...intent,
    runId: null,
    runAttempt: null,
    trigger: "manual",
    image: null,
    actorUserId: "verified",
    requestId: "00000000-0000-4000-8000-000000000001",
    id: "00000000-0000-4000-8000-000000000002",
    reporterId: "api-service",
    requestedAt: 0,
    deadlineAt: 100,
    baseline: null,
    tagWrite: null,
    queue: "acknowledged",
    queueClaimedAt: 0,
    outcome: "queued",
    correlation: "pending",
    after: null,
    landedAt: null,
    lateLandedAt: null,
  };
  expect(deployAttemptResponseSchema.safeParse(record).success).toBe(true);
  const { actorUserId, requestId, ...withoutActor } = record;
  expect(actorUserId).toBe("verified");
  expect(requestId).toBe(record.requestId);
  expect(deployAttemptResponseSchema.safeParse({ ...withoutActor, ...intent }).success).toBe(true);
  const recreated = {
    ...record,
    outcome: "recreated",
    recreatedAt: 1,
    after: {
      containerId: "d".repeat(64),
      observedAt: 1,
      image: {
        repository: intent.image.repository,
        platform: intent.image.platform,
        digestKind: "manifest",
        digest: intent.image.digest,
      },
    },
  };
  expect(deployAttemptResponseSchema.safeParse(recreated).success).toBe(true);
  expect(
    deployAttemptResponseSchema.safeParse({ ...recreated, outcome: "timed-out" }).success,
  ).toBe(true);
  for (const invalid of [
    { ...recreated, recreatedAt: 2 },
    { ...recreated, recreatedAt: null },
    { ...recreated, outcome: "queued" },
    { ...recreated, correlation: "verified" },
    { ...record, outcome: "recreated" },
    { ...record, runId: "123" },
    { ...record, actorUserId: undefined },
    { ...record, trigger: "ci" },
    { ...record, tagWrite: "acknowledged" },
    { ...record, outcome: "landed" },
    { ...record, correlation: "verified" },
    { ...record, landedAt: 1 },
  ])
    expect(deployAttemptResponseSchema.safeParse(invalid).success).toBe(false);
});

describe("already-current execution evidence", () => {
  const record = {
    ...intent,
    id: "00000000-0000-4000-8000-000000000001",
    reporterId: "ci-service",
    requestedAt: 100,
    deadlineAt: 40_000,
    baseline: { containerId: "c".repeat(64), observedAt: 90 },
    tagWrite: null,
    queue: null,
    queueClaimedAt: null,
    outcome: "already-current",
    correlation: "verified",
    after: {
      containerId: "c".repeat(64),
      observedAt: 90,
      image: {
        repository: intent.image.repository,
        platform: intent.image.platform,
        digestKind: intent.image.digestKind,
        digest: intent.image.digest,
      },
    },
    landedAt: null,
    lateLandedAt: null,
    completedAt: 101,
    failureReason: null,
  };

  it("resolves a matching running CI image without claiming a new deployment", () => {
    const parsed = deployAttemptResponseSchema.parse(record);
    expect(parsed.outcome).toBe("already-current");
    expect(parsed.landedAt).toBeNull();
    expect(parsed.queue).toBeNull();
    expect(hasUnresolvedDeploymentWork(parsed)).toBe(false);
    expect(deployAttemptResponseSchema.parse({ ...record, tagWrite: "acknowledged" }).outcome).toBe(
      "already-current",
    );
  });

  it("requires the same container and exact requested immutable image", () => {
    for (const invalid of [
      { ...record, baseline: null },
      { ...record, after: null },
      { ...record, after: { ...record.after, containerId: "d".repeat(64) } },
      { ...record, after: { ...record.after, observedAt: 91 } },
      {
        ...record,
        after: {
          ...record.after,
          image: { ...record.after.image, digest: `sha256:${"e".repeat(64)}` },
        },
      },
      {
        ...record,
        after: {
          ...record.after,
          image: { ...record.after.image, repository: "ghcr.io/foreign/api" },
        },
      },
      {
        ...record,
        after: { ...record.after, image: { ...record.after.image, platform: "linux/arm64" } },
      },
      { ...record, correlation: "pending" },
    ]) {
      expect(deployAttemptResponseSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("rejects mutation, landing, missing completion or stale evidence claims", () => {
    for (const invalid of [
      { ...record, trigger: "rollback" },
      { ...record, trigger: "manual" },
      { ...record, image: null },
      { ...record, tagWrite: "started" },
      { ...record, tagWrite: "unknown" },
      { ...record, tagWrite: "rejected" },
      { ...record, queue: "acknowledged" },
      { ...record, queueClaimedAt: 100 },
      { ...record, landedAt: 101 },
      { ...record, lateLandedAt: 101 },
      { ...record, recreatedAt: 101 },
      { ...record, completedAt: undefined },
      { ...record, completedAt: 99 },
      { ...record, completedAt: 89 },
      { ...record, completedAt: record.deadlineAt },
      { ...record, completedAt: 30_090 },
      { ...record, failureReason: "Image tag update was rejected. No deployment was queued." },
    ]) {
      expect(deployAttemptResponseSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("deployment overlap policy", () => {
  it("preserves unresolved mutations after timeout until runtime evidence resolves them", () => {
    const base = {
      outcome: "timed-out" as const,
      recreatedAt: null,
      lateLandedAt: null,
      queue: null,
      tagWrite: null,
    };
    expect(hasUnresolvedDeploymentWork(base)).toBe(false);
    for (const tagWrite of ["started", "unknown"] as const)
      expect(hasUnresolvedDeploymentWork({ ...base, tagWrite })).toBe(true);
    expect(hasUnresolvedDeploymentWork({ ...base, queue: "acknowledged" })).toBe(true);
    expect(hasUnresolvedDeploymentWork({ ...base, outcome: "queued" })).toBe(true);
    expect(hasUnresolvedDeploymentWork({ ...base, outcome: "incomplete" })).toBe(true);
    for (const outcome of ["failed", "landed", "recreated"] as const)
      expect(hasUnresolvedDeploymentWork({ ...base, outcome, queue: "acknowledged" })).toBe(false);
    expect(hasUnresolvedDeploymentWork({ ...base, queue: "acknowledged", recreatedAt: 1 })).toBe(
      false,
    );
    expect(hasUnresolvedDeploymentWork({ ...base, queue: "acknowledged", lateLandedAt: 1 })).toBe(
      false,
    );
  });
});
