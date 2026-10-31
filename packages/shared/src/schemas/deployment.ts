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
  }),
]);

export const deployReconciliationResponseSchema = z.strictObject({
  checkedAt: timestampSchema,
  results: z
    .array(
      z.discriminatedUnion("outcome", [
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
      ]),
    )
    .max(100),
});

export type DeployStateResponse = z.output<typeof deployStateResponseSchema>;
export type DeployHealthHistoryResponse = z.output<typeof deployHealthHistoryResponseSchema>;
export type DeployReconciliationResponse = z.output<typeof deployReconciliationResponseSchema>;
