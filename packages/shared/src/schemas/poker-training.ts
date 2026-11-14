import { z } from "zod";

const count = z.number().int().nonnegative();
const optionalCount = count.nullable().optional();
const rate = z.number().min(0).max(1);
export const pokerTrainingCollectionSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  total: optionalCount,
  saved: optionalCount,
  queued: optionalCount,
  reviewed_queue: optionalCount,
  reviewed: optionalCount,
  eligible: optionalCount,
  reserved: optionalCount,
  reservations: z
    .object({
      reserved: count,
      validation: count,
      test: count,
      reasons: z.array(z.string()),
    })
    .optional(),
  names: optionalCount,
  blanks: optionalCount,
  pending: optionalCount,
  blocked: optionalCount,
  reason: z.string().nullable().optional(),
  revision: z.string().optional(),
});
export const pokerTrainingAnalysisSchema = z.object({
  ready: z.boolean(),
  accepted: optionalCount,
  reserved: optionalCount,
  duplicates: optionalCount,
  rejected: optionalCount,
  names: optionalCount,
  blanks: optionalCount,
  train: optionalCount,
  validation: optionalCount,
  test: optionalCount,
  blockers: z.array(z.string()).default([]),
  collections: z.array(pokerTrainingCollectionSchema).optional(),
  exclusions: z.array(z.object({ reason: z.string(), count })).optional(),
});
export const pokerTrainingWorkerSchema = z.object({
  role: z.enum(["general", "names"]),
  stage_id: z.string().optional(),
  waiting_reason: z.string().optional(),
  host: z.string(),
  gpu: z.string().nullable().optional(),
  step: optionalCount,
  global_step: optionalCount,
  steps_per_epoch: optionalCount,
  eta_seconds: z.number().nonnegative().nullable().optional(),
  updated_at: z.number().finite().optional(),
  state: z.string(),
  epoch: z.number().nonnegative().nullable().optional(),
  epochs: count.nullable().optional(),
  loss: z.number().finite().nullable().optional(),
  elapsed_seconds: z.number().nonnegative().nullable().optional(),
  error: z.string().nullable().optional(),
});
export const pokerTrainingBenchmarkResultSchema = z.object({
  role: z.enum(["general", "names"]),
  condition: z.string(),
  category: z.string(),
  samples: count,
  exact_match: rate,
  baseline_exact_match: rate.nullable().optional(),
  cer: z.number().nonnegative(),
  p95_ms: z.number().nonnegative().nullable().optional(),
  regressions: optionalCount,
  improved: optionalCount,
  processing_errors: optionalCount,
});
export const pokerTrainingDataProgressSchema = z.object({
  stage: z.enum(["reading", "validating", "deduplicating", "reserving", "ready"]),
  completed: z.number().int().min(0).max(1_000_000_000).optional(),
  total: z.number().int().min(0).max(1_000_000_000).optional(),
  collection_name: z.string().max(100).optional(),
});
export const pokerTrainingRunSchema = z.object({
  id: z.string().min(1),
  created_at: z.number().finite(),
  updated_at: z.number().finite().optional(),
  finished_at: z.number().finite().optional(),
  kind: z.enum(["analysis", "training"]).default("training"),
  version: count.optional(),
  display_name: z.string().optional(),
  stopped_by_user: z.boolean().optional(),
  can_resume: z.boolean().optional(),
  status: z.enum([
    "queued",
    "preparing",
    "training",
    "benchmarking",
    "completed",
    "failed",
    "interrupted",
  ]),
  stage: z.string(),
  data_progress: pokerTrainingDataProgressSchema.optional(),
  error: z.string().nullable().optional(),
  collections: z.array(z.string()),
  epochs: z.number().int().min(1).max(100),
  analysis: pokerTrainingAnalysisSchema.nullable().optional(),
  workers: z.array(pokerTrainingWorkerSchema).optional(),
  summary: z
    .object({
      accepted: count,
      reserved: optionalCount,
      duplicates: count,
      rejected: count,
      train: optionalCount,
      selected_training: optionalCount,
      inherited_holdouts: optionalCount,
      inherited_blank_controls: optionalCount,
      validation: optionalCount,
      test: optionalCount,
      exclusions: z.array(z.object({ reason: z.string(), count })).optional(),
    })
    .nullable()
    .optional(),
  benchmark: z
    .object({
      exact_match: rate,
      cer: z.number().nonnegative(),
      p50_ms: z.number().nonnegative().optional(),
      p95_ms: z.number().nonnegative(),
      baseline_exact_match: rate.optional(),
      samples: optionalCount,
      processing_errors: optionalCount,
      regressions: optionalCount,
      improved: optionalCount,
      results: z.array(pokerTrainingBenchmarkResultSchema).optional(),
    })
    .nullable()
    .optional(),
});
export const pokerTrainingActiveReleaseSchema = z.object({
  id: z.string().optional(),
  display_name: z.string().optional(),
  configured: z.boolean().optional(),
  path: z.string().optional(),
  name: z.string().optional(),
  general_sha256: z.string().nullable().optional(),
  names_sha256: z.string().nullable().optional(),
  error: z.string().optional(),
});
export const pokerTrainingActiveSchema = z.object({
  active_release: pokerTrainingActiveReleaseSchema.nullable(),
});
export type PokerTrainingActiveRelease = z.infer<typeof pokerTrainingActiveReleaseSchema>;
export const pokerTrainingVersionSchema = z.object({
  id: z.string().min(1).max(128),
  display_name: z.string(),
  created_at: z.number().finite(),
  active: z.boolean(),
  eligible: z.boolean(),
  reason: z.string().nullable().optional(),
  benchmark: pokerTrainingRunSchema.shape.benchmark,
  benchmark_source_id: z.string().optional(),
  regressions: count,
  improved: count,
});
export const pokerTrainingVersionsSchema = z.object({
  active_release: pokerTrainingActiveReleaseSchema.nullable(),
  versions: z.array(pokerTrainingVersionSchema),
});
export const pokerTrainingActivateSchema = z.strictObject({
  id: z.string().min(1).max(128),
  acknowledge_regressions: z.boolean().optional(),
});
export type PokerTrainingVersion = z.infer<typeof pokerTrainingVersionSchema>;
export const pokerTrainingStateSchema = z.object({
  analysis_protocol: z.string().optional(),
  runs: z.array(pokerTrainingRunSchema),
  analyses: z.array(pokerTrainingRunSchema).default([]),
  collections: z.array(pokerTrainingCollectionSchema).optional(),
  active_release: pokerTrainingActiveReleaseSchema.nullable().optional(),
  gpu_status: z
    .object({
      checked_at: z.number().finite(),
      devices: z.array(
        z.object({
          host: z.string(),
          gpu: z.string().nullable(),
          ready: z.boolean(),
          error: z.string().nullable().optional(),
          memory_total_mb: z.number().nonnegative().optional(),
          memory_used_mb: z.number().nonnegative().optional(),
          utilization: z.number().min(0).max(100).optional(),
        }),
      ),
    })
    .nullable()
    .optional(),
  setup: z.object({ ready: z.boolean(), error: z.string().nullable().optional() }),
});
export const pokerTrainingStartSchema = z
  .object({
    collections: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .refine((value) => new Set(value).size === value.length, "Collections must be unique"),
    epochs: z.number().int().min(1).max(100).default(6),
  })
  .strict();
export const pokerTrainingStartedSchema = z.object({ run: pokerTrainingRunSchema });
const pokerTrainingArtifactsSchema = z.object({
  general: z.record(z.string(), z.string()).optional(),
  names: z.record(z.string(), z.string()).optional(),
});
export const pokerTrainingTelemetrySchema = z.object({
  histories: z
    .array(
      z.object({
        role: z.enum(["general", "names"]),
        stage_id: z.string(),
        points: z
          .array(
            z.object({
              step: count,
              loss: z.number().finite(),
              epoch: count.optional(),
              elapsed_seconds: z.number().finite().nonnegative().optional(),
              updated_at: z.number().finite().nonnegative().optional(),
            }),
          )
          .max(160),
      }),
    )
    .max(6),
  samples: z
    .array(
      z.object({
        sample_id: z.string(),
        collection_id: z.string().optional(),
        role: z.enum(["general", "names"]),
        category: z.string(),
        label: z.string(),
        image_url: z.string().nullable(),
      }),
    )
    .max(8),
  benchmark: z
    .object({
      pass: z.enum(["baseline", "candidate"]).optional(),
      condition: z.string().optional(),
      processed: count.optional(),
      total: count.optional(),
      cases: z
        .array(
          z.object({
            sample_id: z.string(),
            role: z.enum(["general", "names"]),
            category: z.string(),
            condition: z.string(),
            label: z.string(),
            baseline_prediction: z.string().nullable(),
            candidate_prediction: z.string().nullable(),
            baseline_exact: z.boolean().nullable(),
            candidate_exact: z.boolean().nullable(),
            image_url: z.string().nullable(),
          }),
        )
        .max(16),
    })
    .optional(),
});
export type PokerTrainingTelemetry = z.infer<typeof pokerTrainingTelemetrySchema>;
export const pokerTrainingDetailsSchema = z.object({
  telemetry: pokerTrainingTelemetrySchema.optional(),
  version: z
    .object({
      id: z.string(),
      roles: z.array(z.enum(["general", "names"])).optional(),
      artifacts: pokerTrainingArtifactsSchema.optional(),
      baseline_artifacts: pokerTrainingArtifactsSchema.optional(),
      dataset_sha256: z.string().optional(),
      test_sha256: z.string().optional(),
      runtime_model_replaced: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  run: pokerTrainingRunSchema,
  analysis: pokerTrainingAnalysisSchema.nullable().optional(),
  workers: z.array(pokerTrainingWorkerSchema).nullable().optional(),
  logs: z
    .object({
      supervisor: z.string().nullable().optional(),
      general: z.string().nullable().optional(),
      names: z.string().nullable().optional(),
      export: z.string().nullable().optional(),
      benchmark: z.string().nullable().optional(),
    })
    .optional(),
});
export type PokerTrainingRun = z.infer<typeof pokerTrainingRunSchema>;
export type PokerTrainingState = z.infer<typeof pokerTrainingStateSchema>;
export type PokerTrainingCollection = z.infer<typeof pokerTrainingCollectionSchema>;
export type PokerTrainingAnalysis = z.infer<typeof pokerTrainingAnalysisSchema>;
export type PokerTrainingWorker = z.infer<typeof pokerTrainingWorkerSchema>;
export type PokerTrainingDetails = z.infer<typeof pokerTrainingDetailsSchema>;
