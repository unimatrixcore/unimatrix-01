import { z } from "zod";

const appSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const timestampSchema = z.number().int().nonnegative().safe();
const repositorySchema = z.string().regex(/^[a-z0-9][a-z0-9./_-]{0,254}$/u);
const runIdSchema = z.string().regex(/^[0-9]{1,24}$/u);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const containerIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const resultSchema = z.enum(["started", "acknowledged", "rejected", "unknown"]);

export const deployRuntimeImageSchema = z.strictObject({
  repository: repositorySchema,
  platform: z.string().regex(/^linux\/(amd64|arm64)(\/v[0-9]+)?$/u),
  digestKind: z.literal("manifest"),
  digest: digestSchema,
});
export const deployRequestedImageSchema = deployRuntimeImageSchema.extend({
  tag: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u),
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
});
export const deployAttemptIntentSchema = z.strictObject({
  repository: repositorySchema,
  runId: runIdSchema,
  runAttempt: z.number().int().min(1).max(1_000_000),
  app: appSchema,
  trigger: z.literal("ci"),
  image: deployRequestedImageSchema,
  commitSubject: z
    .string()
    .min(1)
    .max(240)
    .regex(/^[^\p{Cc}]+$/u)
    .nullable()
    .optional(),
});
export const deployAttemptBatchIntentSchema = z
  .strictObject({ intents: z.array(deployAttemptIntentSchema).min(1).max(64) })
  .refine(
    ({ intents }) => new Set(intents.map((intent) => intent.app)).size === intents.length,
    "A reservation batch requires unique applications",
  )
  .refine(({ intents }) => {
    const first = intents[0];
    if (first === undefined) return false;
    return intents.every(
      (intent) =>
        intent.repository === first.repository &&
        intent.runId === first.runId &&
        intent.runAttempt === first.runAttempt,
    );
  }, "A reservation batch belongs to one repository and CI run attempt");
export const deployAttemptIntentRequestSchema = z.union([
  deployAttemptIntentSchema,
  deployAttemptBatchIntentSchema,
]);
export const deployManualRedeployRequestSchema = z.strictObject({
  app: appSchema,
  requestId: z.uuid(),
});
export const deployManualRedeployInputSchema = deployManualRedeployRequestSchema.extend({
  actorUserId: z.string().min(1).max(128),
});
export type DeployManualRedeployRequest = z.output<typeof deployManualRedeployRequestSchema>;
export type DeployManualRedeployInput = z.output<typeof deployManualRedeployInputSchema>;

export const deployRollbackRequestSchema = deployManualRedeployRequestSchema.extend({
  targetAttemptId: z.uuid(),
});
export const deployRollbackInputSchema = deployRollbackRequestSchema.extend({
  actorUserId: z.string().min(1).max(128),
});
export const deployExecuteInputSchema = z.strictObject({
  app: appSchema,
  attemptId: z.uuid(),
});
export type DeployRollbackRequest = z.output<typeof deployRollbackRequestSchema>;
export type DeployRollbackInput = z.output<typeof deployRollbackInputSchema>;
export type DeployExecuteInput = z.output<typeof deployExecuteInputSchema>;

export const deployAttemptReportSchema = z.strictObject({
  attemptId: z.uuid(),
  stage: z.enum(["tag-write", "queue"]),
  result: resultSchema,
});
export const deployAttemptQuerySchema = z.strictObject({
  latestPerApp: z.literal("true").optional(),
  app: appSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const deployAttemptBaselineSchema = z.strictObject({
  containerId: containerIdSchema,
  observedAt: timestampSchema,
});
export const deployRuntimeEvidenceSchema = z.strictObject({
  app: appSchema,
  containerId: containerIdSchema,
  observedAt: timestampSchema,
  image: deployRuntimeImageSchema,
  metadata: z
    .strictObject({
      name: z.string().min(1).max(256),
      startedAt: timestampSchema.nullable(),
      health: z.enum(["healthy", "unhealthy", "starting"]).nullable(),
      imageTag: z.string().max(128).nullable(),
      commit: z
        .string()
        .regex(/^[a-f0-9]{40}$/u)
        .nullable(),
      commitSubject: z.string().max(512).nullable(),
    })
    .optional(),
});
const afterSchema = deployRuntimeEvidenceSchema.omit({ app: true });
export const deployAttemptResponseSchema = deployAttemptIntentSchema
  .extend({
    trigger: z.enum(["ci", "manual", "rollback"]),
    runId: runIdSchema.nullable(),
    runAttempt: z.number().int().min(1).max(1_000_000).nullable(),
    image: deployRequestedImageSchema.nullable(),
    actorUserId: z.string().min(1).max(128).optional(),
    requestId: z.uuid().optional(),
    targetAttemptId: z.uuid().optional(),
    id: z.uuid(),
    reporterId: z.string().min(1).max(128),
    requestedAt: timestampSchema,
    deadlineAt: timestampSchema,
    baseline: deployAttemptBaselineSchema.nullable(),
    tagWrite: resultSchema.nullable(),
    queue: resultSchema.nullable(),
    queueClaimedAt: timestampSchema.nullable().default(null),
    outcome: z.enum([
      "incomplete",
      "queued",
      "landed",
      "already-current",
      "recreated",
      "failed",
      "timed-out",
    ]),
    recreatedAt: timestampSchema.nullable().optional(),
    correlation: z.enum(["pending", "ambiguous", "verified"]),
    after: afterSchema.nullable(),
    landedAt: timestampSchema.nullable(),
    lateLandedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable().optional(),
    failureReason: z
      .enum([
        "Image tag update was rejected. No deployment was queued.",
        "Dokploy rejected the deployment queue request.",
        "Image tag update has an unknown result. Resolve the pending operation before retrying.",
        "Deployment queue has an unknown result. Resolve the pending operation before retrying.",
        "No fresh baseline container was recorded; replacement cannot be verified.",
        "Runtime image correlation is ambiguous; deployment cannot be verified.",
        "The deployment deadline passed without a verified replacement container.",
      ])
      .nullable()
      .optional(),
  })
  .refine((record) => {
    if (record.image === null) {
      return (
        record.trigger === "manual" &&
        record.runId === null &&
        record.runAttempt === null &&
        record.actorUserId !== undefined &&
        record.requestId !== undefined &&
        record.targetAttemptId === undefined &&
        record.tagWrite === null &&
        record.outcome !== "landed" &&
        record.correlation !== "verified" &&
        ((record.recreatedAt == null && record.after === null && record.outcome !== "recreated") ||
          (record.recreatedAt != null &&
            record.after !== null &&
            record.recreatedAt === record.after.observedAt &&
            (record.outcome === "recreated" || record.outcome === "timed-out"))) &&
        record.landedAt === null &&
        record.lateLandedAt === null
      );
    }
    return (
      record.recreatedAt == null &&
      record.outcome !== "recreated" &&
      ((record.trigger === "rollback" &&
        record.runId === null &&
        record.runAttempt === null &&
        record.actorUserId !== undefined &&
        record.requestId !== undefined &&
        record.targetAttemptId !== undefined) ||
        (record.runId !== null &&
          record.runAttempt !== null &&
          record.actorUserId === undefined &&
          record.requestId === undefined &&
          record.targetAttemptId === undefined))
    );
  }, "Attempt identity must match its target-image provenance")
  .refine((record) => {
    if (record.outcome !== "already-current") return true;
    return (
      record.trigger === "ci" &&
      record.image !== null &&
      record.baseline !== null &&
      record.after !== null &&
      record.baseline.containerId === record.after.containerId &&
      record.baseline.observedAt === record.after.observedAt &&
      record.after.image.repository === record.image.repository &&
      record.after.image.platform === record.image.platform &&
      record.after.image.digestKind === record.image.digestKind &&
      record.after.image.digest === record.image.digest &&
      (record.tagWrite === null || record.tagWrite === "acknowledged") &&
      record.queue === null &&
      record.queueClaimedAt === null &&
      record.correlation === "verified" &&
      record.completedAt != null &&
      record.completedAt >= record.requestedAt &&
      record.completedAt >= record.after.observedAt &&
      record.completedAt < record.deadlineAt &&
      record.completedAt - record.after.observedAt < 30_000 &&
      record.landedAt === null &&
      record.lateLandedAt === null &&
      record.recreatedAt == null &&
      record.failureReason == null
    );
  }, "Already-current attempts require fresh matching evidence without queueing a deployment");
export const deployAttemptHistoryResponseSchema = z.strictObject({
  attempts: z.array(deployAttemptResponseSchema).max(100),
});
export const deployAttemptBatchIntentResponseSchema = z.strictObject({
  attempts: z.array(deployAttemptResponseSchema).min(1).max(64),
});
export const deployAttemptIntentResponseSchema = z.union([
  deployAttemptResponseSchema,
  deployAttemptBatchIntentResponseSchema,
]);

export const deployAttemptLogsQuerySchema = z.strictObject({
  app: appSchema,
  attemptId: z.uuid(),
});
const logSelection = {
  app: appSchema,
  attemptId: z.uuid(),
  policy: z.literal("recognized-events-only"),
  diagnosticLines: z
    .array(
      z.enum([
        "▶ Deployment attempt accepted and recorded.",
        "Immutable target image recorded from CI publication.",
        "Requested image already running; no deployment was queued.",
        "Rollback targets a previously verified deployed image.",
        "Manual redeploy uses the service configuration; no immutable target image was supplied.",
        "Baseline container recorded before deployment.",
        "No baseline container was recorded; replacement cannot be verified.",
        "Image tag update started.",
        "Image tag update acknowledged.",
        "✖ Image tag update rejected; no deployment was queued.",
        "Image tag update result is unknown; retry is blocked until resolved.",
        "Deployment queue request started.",
        "Deployment queue request acknowledged; awaiting runtime verification.",
        "✖ Deployment queue request rejected.",
        "Deployment queue result is unknown; retry is blocked until resolved.",
        "✔ Requested image verified in a replacement container.",
        "✔ Replacement container observed; deployed image remains unverified.",
        "✖ Deployment did not verify before its deadline.",
        "Requested image verified after the deployment deadline.",
        "Replacement container observed after the deployment deadline; image remains unverified.",
      ]),
    )
    .max(20)
    .optional(),
};
export const deployAttemptLogsResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...logSelection,
    status: z.literal("available"),
    events: z
      .array(z.enum(["deployment-initialized", "deployment-completed", "deployment-failed"]))
      .max(100),
    withheld: z.boolean(),
    truncated: z.boolean(),
  }),
  z.strictObject({
    ...logSelection,
    status: z.literal("unavailable"),
    reason: z.enum(["unassociated", "source-unavailable", "ambiguous"]),
  }),
]);

export type DeployAttemptLogsQuery = z.output<typeof deployAttemptLogsQuerySchema>;
export type DeployAttemptLogsResponse = z.output<typeof deployAttemptLogsResponseSchema>;

export type DeployAttemptIntent = z.output<typeof deployAttemptIntentSchema>;
export type DeployAttemptBatchIntent = z.output<typeof deployAttemptBatchIntentSchema>;
export type DeployAttemptBatchIntentResponse = z.output<
  typeof deployAttemptBatchIntentResponseSchema
>;
export type DeployAttemptReport = z.output<typeof deployAttemptReportSchema>;
export type DeployAttemptRecord = z.output<typeof deployAttemptResponseSchema>;
export type DeployAttemptBaseline = z.output<typeof deployAttemptBaselineSchema>;
export type DeployRuntimeEvidence = z.output<typeof deployRuntimeEvidenceSchema>;

export type DeployAttemptRuntimeEvidence = DeployRuntimeEvidence;

export function hasUnresolvedDeploymentWork(
  record: Pick<
    DeployAttemptRecord,
    "outcome" | "recreatedAt" | "lateLandedAt" | "queue" | "tagWrite"
  >,
): boolean {
  return (
    record.outcome !== "failed" &&
    record.outcome !== "landed" &&
    record.outcome !== "already-current" &&
    record.outcome !== "recreated" &&
    record.recreatedAt == null &&
    record.lateLandedAt === null &&
    (record.outcome !== "timed-out" ||
      record.queue !== null ||
      record.tagWrite === "started" ||
      record.tagWrite === "unknown")
  );
}
