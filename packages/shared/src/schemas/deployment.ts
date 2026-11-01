import { z } from "zod";

const appIdentifierSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const timestampSchema = z.number().int().nonnegative().safe();
const freshnessSchema = z.enum(["missing", "fresh", "stale"]);
const identifierSchema = z.string().min(1).max(256);

export const deployStateQuerySchema = z.strictObject({ app: appIdentifierSchema.optional() });
export const deployHealthHistoryQuerySchema = z.strictObject({ app: appIdentifierSchema });
export const deployReconciliationQuerySchema = z.strictObject({
  app: appIdentifierSchema.optional(),
});

const containerObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    appDir: appIdentifierSchema,
    kind: z.literal("unknown"),
    reason: z.enum(["not-polled", "no-match", "ambiguous", "poll-failed"]),
    observedAt: timestampSchema.nullable(),
    freshness: freshnessSchema,
  }),
  z.strictObject({
    appDir: appIdentifierSchema,
    kind: z.literal("matched"),
    observedAt: timestampSchema,
    containerId: identifierSchema,
    image: z.string().min(1).max(2048),
    state: z.string().max(1024),
    status: z.string().max(1024),
    containerAgeMs: z.null(),
    name: z.string().max(256).nullable().default(null),
    startedAt: timestampSchema.nullable().default(null),
    health: z.enum(["healthy", "unhealthy", "starting"]).nullable().default(null),
    imageTag: z.string().max(128).nullable().default(null),
    commit: z
      .string()
      .regex(/^[a-f0-9]{40}$/u)
      .nullable()
      .default(null),
    commitSubject: z.string().max(512).nullable().default(null),
    runtimeMetadataObservedAt: timestampSchema.nullable().default(null),
    firstObservedAt: timestampSchema,
    lastRecreatedAt: timestampSchema.nullable(),
    freshness: freshnessSchema,
  }),
]);

export const deployStateResponseSchema = z.strictObject({
  checkedAt: timestampSchema,
  apps: z
    .array(
      z.strictObject({
        appDir: appIdentifierSchema,
        publicStatus: z.boolean(),
        dokployUrl: z.url().nullable().default(null),
        domains: z
          .array(
            z.strictObject({
              host: z.string().max(253),
              https: z.boolean(),
              port: z.number().int().min(1).max(65535).nullable(),
              path: z.string().max(2048).nullable(),
            }),
          )
          .max(100)
          .nullable()
          .default(null),
        metadataObservedAt: timestampSchema.nullable().default(null),
        metadataFreshness: freshnessSchema.default("missing"),
        container: containerObservationSchema,
      }),
    )
    .max(100),
});

const healthStateSchema = z.enum(["up", "down", "unknown"]);
const healthObservationSchema = z.strictObject({
  app: appIdentifierSchema,
  checkedAt: timestampSchema,
  state: healthStateSchema,
  durationMs: timestampSchema.optional(),
});
const healthSummarySchema = z.strictObject({
  from: timestampSchema,
  to: timestampSchema,
  upMs: timestampSchema,
  downMs: timestampSchema,
  unknownMs: timestampSchema,
  uptimePercent: z.number().min(0).max(100).nullable(),
  coveragePercent: z.number().min(0).max(100),
});

export const deployHealthHistoryResponseSchema = z.strictObject({
  app: appIdentifierSchema,
  current: z.strictObject({
    app: appIdentifierSchema,
    state: healthStateSchema,
    checkedAt: timestampSchema.nullable(),
    durationMs: timestampSchema.optional(),
  }),
  summary: healthSummarySchema,
  days: z.array(healthSummarySchema).max(30),
  recent: z.array(healthObservationSchema).max(60),
  freshness: freshnessSchema,
});

const appDiffSchema = z.discriminatedUnion("verdict", [
  z.strictObject({
    verdict: z.literal("missing"),
    appDir: appIdentifierSchema,
  }),
  z.strictObject({
    verdict: z.literal("ambiguous"),
    appDir: appIdentifierSchema,
    matchCount: z.number().int().min(2).safe(),
  }),
  z.strictObject({
    verdict: z.literal("matched"),
    appDir: appIdentifierSchema,
    composeId: identifierSchema,
    envFindings: z
      .array(
        z.strictObject({
          key: z.string().min(1).max(256),
          state: z.enum([
            "set",
            "blank",
            "missing",
            "optional-absent",
            "undeclared",
            "build-arg-runtime-copy",
          ]),
        }),
      )
      .max(512),
    settingFindings: z
      .array(
        z.strictObject({
          setting: z.enum(["composePath", "sourceType", "branch", "autoDeploy"]),
          declared: z.string().max(4096),
          actual: z.string().max(4096),
        }),
      )
      .max(4),
    inSync: z.boolean(),
    routing: z
      .strictObject({
        sourcePath: z.literal("apps/deploy/src/reconcile/routing-policy.ts"),
        status: z.enum(["in-sync", "drift", "unavailable", "not-declared"]),
        expectedHosts: z.array(z.string().max(253)).max(100),
        observedHosts: z.array(z.string().max(253)).max(100).nullable(),
        missingHosts: z.array(z.string().max(253)).max(100),
        unexpectedHosts: z.array(z.string().max(253)).max(100),
        declaredPort: z.number().int().min(1).max(65535),
        observedPorts: z.array(z.number().int().min(1).max(65535).nullable()).max(100).nullable(),
        portMismatch: z.boolean(),
      })
      .optional(),
  }),
]);

export const deployReconciliationResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    appDir: appIdentifierSchema,
    outcome: z.literal("error"),
    reason: z.literal("read-failed"),
  }),
  z.strictObject({
    appDir: appIdentifierSchema,
    outcome: z.literal("diffed"),
    diff: appDiffSchema,
  }),
]);

export const deployReconciliationResponseSchema = z.strictObject({
  checkedAt: timestampSchema,
  policy: z.literal("scheduled-detection-explicit-apply"),
  status: z.enum(["not-checked", "checking", "checked", "read-failed"]),
  observedAt: timestampSchema.nullable(),
  nextRunAt: timestampSchema.nullable(),
  intervalMs: z.number().int().positive().safe(),
  freshness: freshnessSchema,
  results: z.array(deployReconciliationResultSchema).max(100),
});

export type DeployStateResponse = z.output<typeof deployStateResponseSchema>;
export type DeployHealthHistoryResponse = z.output<typeof deployHealthHistoryResponseSchema>;
export type DeployReconciliationResponse = z.output<typeof deployReconciliationResponseSchema>;
export type DeployReconciliationResult = z.output<typeof deployReconciliationResultSchema>;
