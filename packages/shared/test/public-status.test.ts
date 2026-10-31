import { expect, it } from "vitest";
import {
  publicDeploymentStatusContract,
  publicDeploymentStatusResponseSchema,
} from "../src/index.js";

const summary = { uptimePercent: null, coveragePercent: 0 };
const app = {
  displayName: "API",
  state: "up",
  lastCheckedAt: null,
  history: [],
  summary,
};

it("exposes a static strict public contract with minute precision", () => {
  expect(publicDeploymentStatusContract.path).toBe("/deployment/status");
  expect(publicDeploymentStatusContract.method).toBe("GET");
  expect(publicDeploymentStatusContract.querySchema!.safeParse({ app: "private" }).success).toBe(
    false,
  );
  for (const state of ["up", "down", "degraded"]) {
    expect(
      publicDeploymentStatusResponseSchema.safeParse({
        apps: [{ ...app, state, lastCheckedAt: 60_000 }],
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
        apps: [{ ...app, ...extra }],
      }).success,
    ).toBe(false);
  }
  expect(
    publicDeploymentStatusResponseSchema.safeParse({
      apps: Array(101).fill(app),
    }).success,
  ).toBe(false);
});

it("bounds public history and rejects raw internal fields and invalid windows", () => {
  const day = { from: 0, to: 60_000, ...summary };
  expect(
    publicDeploymentStatusResponseSchema.safeParse({
      apps: [{ ...app, history: Array(30).fill(day) }],
    }).success,
  ).toBe(true);
  for (const history of [
    Array(31).fill(day),
    [{ ...day, to: 60_001 }],
    [{ ...day, from: 120_000 }],
    [{ ...day, uptimePercent: 101 }],
    [{ ...day, coveragePercent: -1 }],
    [{ ...day, app: "private" }],
    [{ ...day, upMs: 60_000 }],
    [{ ...day, observations: [] }],
  ]) {
    expect(
      publicDeploymentStatusResponseSchema.safeParse({
        apps: [{ ...app, history }],
      }).success,
    ).toBe(false);
  }
  expect(
    publicDeploymentStatusResponseSchema.safeParse({
      apps: [{ ...app, summary: { ...summary, error: "private" } }],
    }).success,
  ).toBe(false);
});
