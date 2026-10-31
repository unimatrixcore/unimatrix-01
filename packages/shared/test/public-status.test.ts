import { expect, it } from "vitest";
import {
  publicDeploymentStatusContract,
  publicDeploymentStatusResponseSchema,
} from "../src/index.js";

it("exposes a static strict public contract with minute precision", () => {
  expect(publicDeploymentStatusContract.path).toBe("/deployment/status");
  expect(publicDeploymentStatusContract.method).toBe("GET");
  expect(publicDeploymentStatusContract.querySchema!.safeParse({ app: "private" }).success).toBe(
    false,
  );
  for (const state of ["up", "down", "degraded"]) {
    expect(
      publicDeploymentStatusResponseSchema.safeParse({
        apps: [{ displayName: "API", state, lastCheckedAt: 60_000 }],
      }).success,
    ).toBe(true);
  }
  for (const extra of [
    { containerId: "private" },
    { image: "private" },
    { latency: 12 },
    { error: "private" },
    { lastCheckedAt: 60_001 },
    { state: "unknown" },
  ]) {
    expect(
      publicDeploymentStatusResponseSchema.safeParse({
        apps: [{ displayName: "API", state: "up", lastCheckedAt: null, ...extra }],
      }).success,
    ).toBe(false);
  }
  expect(
    publicDeploymentStatusResponseSchema.safeParse({
      apps: Array(101).fill({ displayName: "API", state: "degraded", lastCheckedAt: null }),
    }).success,
  ).toBe(false);
});
