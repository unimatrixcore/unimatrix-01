import { describe, expect, it } from "vitest";
import {
  deployAttemptIntentSchema,
  deployAttemptReportSchema,
  deployAttemptQuerySchema,
  deployAttemptIntentContract,
  deployAttemptReportContract,
  deployAttemptHistoryContract,
  deployRuntimeEvidenceSchema,
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
