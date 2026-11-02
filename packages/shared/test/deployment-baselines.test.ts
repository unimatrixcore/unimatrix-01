import { describe, expect, it } from "vitest";

import {
  deployBaselinesContract,
  deployBaselinesQuerySchema,
  deployBaselinesResponseSchema,
} from "../src/index.js";

const baseline = {
  commit: "a".repeat(40),
  containerId: "b".repeat(64),
  observedAt: 123,
  image: {
    repository: "ghcr.io/unimatrixcore/unimatrix-api",
    platform: "linux/amd64",
    digestKind: "manifest",
    digest: `sha256:${"c".repeat(64)}`,
  },
};

describe("deployment baselines", () => {
  it("pairs the static read contract with strict schemas", () => {
    expect(deployBaselinesContract.method).toBe("GET");
    expect(deployBaselinesContract.path).toBe("/deployment/baselines");
    expect(deployBaselinesQuerySchema.parse({})).toEqual({});
    expect(deployBaselinesQuerySchema.safeParse({ app: "api" }).success).toBe(false);
    expect(
      deployBaselinesResponseSchema.parse({
        checkedAt: 124,
        apps: [
          { app: "api", baseline },
          { app: "web", baseline: null },
        ],
      }).apps,
    ).toHaveLength(2);
  });

  it("refuses duplicate apps, malformed provenance, extra values and invalid times", () => {
    for (const apps of [
      [
        { app: "api", baseline },
        { app: "api", baseline: null },
      ],
      [{ app: "api", baseline: { ...baseline, commit: "main" } }],
      [{ app: "api", baseline: { ...baseline, containerId: "short" } }],
      [{ app: "api", baseline: { ...baseline, observedAt: -1 } }],
      [{ app: "api", baseline: { ...baseline, secret: "hidden" } }],
      [{ app: "api", baseline: { ...baseline, image: { ...baseline.image, digest: "bad" } } }],
    ]) {
      expect(deployBaselinesResponseSchema.safeParse({ checkedAt: 124, apps }).success).toBe(false);
    }
  });
});
