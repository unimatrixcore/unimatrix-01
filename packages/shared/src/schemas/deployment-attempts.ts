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
  trigger: z.enum(["ci", "manual", "rollback"]),
  image: deployRequestedImageSchema,
});
export const deployManualRedeployRequestSchema = z.strictObject({
  app: appSchema,
  requestId: z.uuid(),
});
export const deployManualRedeployInputSchema = deployManualRedeployRequestSchema.extend({
  actorUserId: z.string().min(1).max(128),
});
export type DeployManualRedeployRequest = z.output<typeof deployManualRedeployRequestSchema>;
export type DeployManualRedeployInput = z.output<typeof deployManualRedeployInputSchema>;

export const deployAttemptReportSchema = z.strictObject({
  attemptId: z.uuid(),
  stage: z.enum(["tag-write", "queue"]),
  result: resultSchema,
});
export const deployAttemptQuerySchema = z.strictObject({
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
});
const afterSchema = deployRuntimeEvidenceSchema.omit({ app: true });
export const deployAttemptResponseSchema = deployAttemptIntentSchema
  .extend({
    runId: runIdSchema.nullable(),
    runAttempt: z.number().int().min(1).max(1_000_000).nullable(),
    image: deployRequestedImageSchema.nullable(),
    actorUserId: z.string().min(1).max(128).optional(),
    requestId: z.uuid().optional(),
    id: z.uuid(),
    reporterId: z.string().min(1).max(128),
    requestedAt: timestampSchema,
    deadlineAt: timestampSchema,
    baseline: deployAttemptBaselineSchema.nullable(),
    tagWrite: resultSchema.nullable(),
    queue: resultSchema.nullable(),
    queueClaimedAt: timestampSchema.nullable().default(null),
    outcome: z.enum(["incomplete", "queued", "landed", "recreated", "failed", "timed-out"]),
    recreatedAt: timestampSchema.nullable().optional(),
    correlation: z.enum(["pending", "ambiguous", "verified"]),
    after: afterSchema.nullable(),
    landedAt: timestampSchema.nullable(),
    lateLandedAt: timestampSchema.nullable(),
  })
  .refine((record) => {
    if (record.image === null) {
      return (
        record.trigger === "manual" &&
        record.runId === null &&
        record.runAttempt === null &&
        record.actorUserId !== undefined &&
        record.requestId !== undefined &&
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
      record.runId !== null &&
      record.runAttempt !== null &&
      record.actorUserId === undefined &&
      record.requestId === undefined
    );
  }, "Attempt identity must match its target-image provenance");
export const deployAttemptHistoryResponseSchema = z.strictObject({
  attempts: z.array(deployAttemptResponseSchema).max(100),
});

export const deployAttemptLogsQuerySchema = z.strictObject({
  app: appSchema,
  attemptId: z.uuid(),
});
const logSelection = {
  app: appSchema,
  attemptId: z.uuid(),
  policy: z.literal("recognized-events-only"),
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
export type DeployAttemptReport = z.output<typeof deployAttemptReportSchema>;
export type DeployAttemptRecord = z.output<typeof deployAttemptResponseSchema>;
export type DeployAttemptBaseline = z.output<typeof deployAttemptBaselineSchema>;
export type DeployRuntimeEvidence = z.output<typeof deployRuntimeEvidenceSchema>;

export type DeployAttemptRuntimeEvidence = DeployRuntimeEvidence;
