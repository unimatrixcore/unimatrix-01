import { describe, expect, it } from "vitest";
import {
  pokerTrainingRunSchema,
  pokerTrainingStartSchema,
  pokerTrainingStateSchema,
  pokerTrainingActiveSchema,
  pokerTrainingVersionsSchema,
  pokerTrainingActivateSchema,
  pokerTrainingDataProgressSchema,
  pokerTrainingTelemetrySchema,
  pokerTrainingDetailsSchema,
} from "../src/schemas/poker-training";

describe("OCR training boundaries", () => {
  it("validates bounded optional training histories and paired frozen cases", () => {
    const point = { step: 3, loss: 0.4, epoch: 1, elapsed_seconds: 2, updated_at: 123 };
    const sample = {
      sample_id: "case:1",
      role: "names",
      category: "name",
      label: "Alice",
      image_url: "/api/training/sample?run=one&sample_id=case%3A1",
    };
    const item = {
      ...sample,
      condition: "identity",
      baseline_prediction: "Alice",
      candidate_prediction: null,
      baseline_exact: true,
      candidate_exact: null,
    };
    const telemetry = {
      histories: [{ role: "names", stage_id: "names-base", points: [point] }],
      samples: [sample],
      benchmark: {
        pass: "candidate",
        condition: "identity",
        processed: 1,
        total: 12,
        cases: [item],
      },
    };
    expect(pokerTrainingTelemetrySchema.parse(telemetry)).toEqual(telemetry);
    expect(
      pokerTrainingTelemetrySchema.parse({
        ...telemetry,
        samples: [{ ...sample, collection_id: "legacy" }],
      }).samples[0]?.collection_id,
    ).toBe("legacy");
    expect(
      pokerTrainingTelemetrySchema.safeParse({
        ...telemetry,
        samples: [{ ...sample, collection_id: 1 }],
      }).success,
    ).toBe(false);
    expect(
      pokerTrainingTelemetrySchema.safeParse({
        ...telemetry,
        histories: [{ ...telemetry.histories[0], points: [{ ...point, loss: Infinity }] }],
      }).success,
    ).toBe(false);
    expect(
      pokerTrainingTelemetrySchema.safeParse({
        ...telemetry,
        histories: [
          { ...telemetry.histories[0], points: Array.from({ length: 161 }, () => point) },
        ],
      }).success,
    ).toBe(false);
    expect(
      pokerTrainingTelemetrySchema.safeParse({
        ...telemetry,
        histories: Array.from({ length: 7 }, () => telemetry.histories[0]),
      }).success,
    ).toBe(false);
    expect(
      pokerTrainingTelemetrySchema.safeParse({
        ...telemetry,
        samples: Array.from({ length: 9 }, () => sample),
      }).success,
    ).toBe(false);
    expect(
      pokerTrainingTelemetrySchema.safeParse({
        ...telemetry,
        benchmark: { ...telemetry.benchmark, cases: Array.from({ length: 17 }, () => item) },
      }).success,
    ).toBe(false);
    const legacy = {
      run: {
        id: "legacy",
        created_at: 1,
        status: "completed",
        stage: "Done",
        collections: [],
        epochs: 6,
      },
    };
    expect(pokerTrainingDetailsSchema.parse(legacy)).not.toHaveProperty("telemetry");
  });
  it("validates reported data preparation stages and actual counters", () => {
    const progress = {
      stage: "validating",
      completed: 12,
      total: 40,
      collection_name: "Live Review",
    };
    expect(pokerTrainingDataProgressSchema.parse(progress)).toEqual(progress);
    expect(pokerTrainingDataProgressSchema.safeParse({ stage: "guessing" }).success).toBe(false);
    expect(pokerTrainingDataProgressSchema.safeParse({ ...progress, completed: -1 }).success).toBe(
      false,
    );
  });
  it("validates activation choices and rejects arbitrary activation settings", () => {
    const version = {
      id: "baseline",
      display_name: "Original models",
      created_at: 0,
      active: true,
      eligible: true,
      regressions: 0,
      improved: 0,
    };
    expect(
      pokerTrainingVersionsSchema.parse({ active_release: null, versions: [version] }),
    ).toEqual({ active_release: null, versions: [version] });
    expect(pokerTrainingActivateSchema.parse({ id: "baseline" })).toEqual({ id: "baseline" });
    expect(
      pokerTrainingActivateSchema.parse({ id: "candidate", acknowledge_regressions: true }),
    ).toEqual({ id: "candidate", acknowledge_regressions: true });
    expect(pokerTrainingActivateSchema.safeParse({ id: "" }).success).toBe(false);
    expect(
      pokerTrainingActivateSchema.safeParse({ id: "candidate", path: "/tmp/model" }).success,
    ).toBe(false);
    expect(
      pokerTrainingVersionsSchema.safeParse({
        active_release: null,
        versions: [{ ...version, regressions: -1 }],
      }).success,
    ).toBe(false);
  });
  it("validates lightweight active model metadata without requiring training history", () => {
    const active = {
      configured: true,
      general_sha256: "a".repeat(64),
      names_sha256: "b".repeat(64),
    };
    expect(pokerTrainingActiveSchema.parse({ active_release: active })).toEqual({
      active_release: active,
    });
    expect(
      pokerTrainingActiveSchema.safeParse({ active_release: { names_sha256: 42 } }).success,
    ).toBe(false);
  });
  it("accepts collection selection with default epochs and rejects unsupported controls", () => {
    expect(pokerTrainingStartSchema.parse({ collections: ["one"] })).toEqual({
      collections: ["one"],
      epochs: 6,
    });
    for (const input of [
      { collections: [] },
      { collections: ["one", "one"] },
      { collections: ["one"], epochs: 0 },
      { collections: ["one"], epochs: 101 },
      { collections: ["one"], command: "shell" },
      { collections: Array.from({ length: 101 }, (_, index) => String(index)) },
    ])
      expect(pokerTrainingStartSchema.safeParse(input).success).toBe(false);
  });

  it("validates persisted stages and benchmark measurements", () => {
    const run = {
      id: "version",
      created_at: 1,
      status: "completed",
      stage: "Benchmark complete",
      collections: ["one"],
      epochs: 6,
      summary: {
        accepted: 12,
        duplicates: 3,
        rejected: 1,
        selected_training: 10,
        inherited_holdouts: 2,
        inherited_blank_controls: 4,
      },
      benchmark: {
        exact_match: 0.9,
        baseline_exact_match: 0.8,
        cer: 0.1,
        p95_ms: 3,
        regressions: 1,
        improved: 2,
      },
    };
    expect(pokerTrainingRunSchema.parse(run)).toEqual({ ...run, kind: "training" });
    expect(
      pokerTrainingStateSchema.parse({ runs: [run], setup: { ready: true } }).runs,
    ).toHaveLength(1);
    expect(pokerTrainingRunSchema.safeParse({ ...run, status: "promoted" }).success).toBe(false);
    expect(
      pokerTrainingRunSchema.safeParse({ ...run, benchmark: { ...run.benchmark, exact_match: 90 } })
        .success,
    ).toBe(false);
  });
});
