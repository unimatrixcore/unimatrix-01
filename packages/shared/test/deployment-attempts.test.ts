import { describe, expect, it } from "vitest";
import {
  deployAttemptIntentSchema,
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
