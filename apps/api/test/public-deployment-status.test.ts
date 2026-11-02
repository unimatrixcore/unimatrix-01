import assert from "node:assert/strict";
import test from "node:test";
import type { DeployClient } from "@unimatrix/deploy-client";
import type { DeployHealthHistoryResponse, DeployStateResponse } from "@unimatrix/shared";

import { buildApp } from "../src/app.js";
import { loadApiRuntimeConfig } from "../src/config.js";
import { createPublicStatusReader, selectPublicApps } from "../src/modules/deployment/status.js";

function state(): DeployStateResponse {
  return {
    checkedAt: 120_123,
    apps: ["web", "api", "private"].map((appDir) => ({
      appDir,
      publicStatus: appDir !== "private",
      dokployUrl: null,
      domains: null,
      primaryDomain: null,
      metadataObservedAt: null,
      metadataFreshness: "missing",
      container: {
        appDir,
        kind: "unknown",
        reason: "not-polled",
        observedAt: null,
        freshness: "missing",
      },
    })),
  };
}
function health(
  app: string,
  overrides: Partial<DeployHealthHistoryResponse> = {},
): DeployHealthHistoryResponse {
  return {
    app,
    current: { app, state: "up", checkedAt: 120_123 },
    freshness: "fresh",
    days: [],
    recent: [],
    summary: {
      from: 0,
      to: 120_123,
      upMs: 0,
      downMs: 0,
      unknownMs: 120_123,
      uptimePercent: null,
      coveragePercent: 0,
    },
    ...overrides,
  };
}
function client(overrides: Partial<DeployClient> = {}): DeployClient {
  return {
    rollback: () => Promise.reject(new Error("Unused rollback")),
    redeploy: () => Promise.reject(new Error("Unused redeploy")),
    getState: () => Promise.resolve(state()),
    getHealth: (app) => Promise.resolve(health(app)),
    getReconciliation: () =>
      Promise.resolve({
        checkedAt: 0,
        policy: "scheduled-detection-explicit-apply",
        status: "not-checked",
        observedAt: null,
        nextRunAt: null,
        intervalMs: 900000,
        freshness: "missing",
        results: [],
      }),
    getDeclarations: () => Promise.resolve({ apps: [] }),
    getAttempts: () => Promise.resolve({ attempts: [] }),
    getAttemptLogs: (query) =>
      Promise.resolve({
        ...query,
        status: "unavailable",
        policy: "recognized-events-only",
        reason: "unassociated",
      }),
    ...overrides,
  };
}

void test("visibility defaults to denied when a fixture declares nothing", () => {
  assert.deepEqual(
    selectPublicApps([
      { appDir: "undeclared" },
      { appDir: "hidden", publicStatus: false },
      { appDir: "web", publicStatus: true },
    ]),
    [{ appDir: "web", publicStatus: true }],
  );
});

void test("public route requires no Clerk and returns only coarse allowed fields", async () => {
  const requested: string[] = [];
  const app = buildApp(loadApiRuntimeConfig({ NODE_ENV: "test", LOG_LEVEL: "error" }), {
    deployClient: client({
      getHealth: (name) => {
        requested.push(name);
        return Promise.resolve(
          health(name, { current: { app: name, state: "down", checkedAt: Date.now() } }),
        );
      },
    }),
  });
  try {
    const result = await app.inject({ method: "GET", url: "/deployment/status" });
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers["cache-control"], "no-store");
    const body = result.json<{
      apps: { displayName: string; state: string; lastCheckedAt: number }[];
    }>();
    assert.deepEqual(requested.sort(), ["api", "web"]);
    assert.deepEqual(
      body.apps.map((entry) => entry.displayName),
      ["Unimatrix", "API"],
    );
    for (const entry of body.apps) {
      assert.deepEqual(Object.keys(entry).sort(), [
        "displayName",
        "history",
        "lastCheckedAt",
        "state",
        "summary",
      ]);
      assert.equal(entry.state, "down");
      assert.equal(entry.lastCheckedAt % 60_000, 0);
    }
    assert.equal((await app.inject("/deployment/status?app=private")).statusCode, 400);
  } finally {
    await app.close();
  }
});

void test("public history keeps only daily availability and weights its displayed window", async () => {
  const read = createPublicStatusReader(
    client({
      getHealth: (app) =>
        Promise.resolve(
          health(app, {
            summary: {
              from: 0,
              to: 180_123,
              upMs: 180_123,
              downMs: 0,
              unknownMs: 0,
              uptimePercent: 100,
              coveragePercent: 100,
            },
            days: [
              {
                from: 0,
                to: 60_000,
                upMs: 30_000,
                downMs: 30_000,
                unknownMs: 0,
                uptimePercent: 50,
                coveragePercent: 100,
              },
              {
                from: 60_000,
                to: 180_123,
                upMs: 0,
                downMs: 0,
                unknownMs: 120_123,
                uptimePercent: null,
                coveragePercent: 0,
              },
            ],
            recent: [{ app, checkedAt: 120_123, state: "up" }],
          }),
        ),
    }),
    () => 130_000,
  );
  const result = await read();
  for (const app of result.apps) {
    assert.deepEqual(app.history, [
      { from: 0, to: 60_000, uptimePercent: 50, coveragePercent: 100 },
      { from: 60_000, to: 180_000, uptimePercent: null, coveragePercent: 0 },
    ]);
    assert.deepEqual(app.summary, {
      uptimePercent: 50,
      coveragePercent: (100 * 60_000) / 180_123,
    });
  }
  assert.ok(!JSON.stringify(result).includes("recent"));
  assert.ok(!JSON.stringify(result).includes("upMs"));
  assert.ok(!JSON.stringify(result).includes("private"));
});

void test("coalesces concurrent refreshes and expires cached evidence at the probe boundary", async () => {
  let now = 179_000;
  let calls = 0;
  const read = createPublicStatusReader(
    client({
      getState: () => {
        calls++;
        return Promise.resolve(state());
      },
    }),
    () => now,
  );
  const results = await Promise.all(Array.from({ length: 30 }, () => read()));
  assert.equal(calls, 1);
  assert.equal(results[0]!.apps[0]!.state, "up");
  now = 180_123;
  assert.equal((await read()).apps[0]!.state, "degraded");
  assert.equal(calls, 1);
  now = 194_000;
  await read();
  assert.equal(calls, 2);
});

void test("missing, stale, future, unknown, mismatched and failed probes are degraded", async () => {
  for (const observation of [
    health("web", {
      freshness: "missing",
      current: { app: "web", state: "unknown", checkedAt: null },
    }),
    health("web", { freshness: "stale" }),
    health("web", { current: { app: "web", state: "unknown", checkedAt: 120_123 } }),
    health("web", { current: { app: "web", state: "up", checkedAt: 200_000 } }),
    health("private"),
    null,
  ]) {
    const read = createPublicStatusReader(
      client({
        getHealth: () =>
          observation === null
            ? Promise.reject(new Error("PRIVATE HOST"))
            : Promise.resolve(observation),
      }),
      () => 130_000,
    );
    const result = await read();
    assert.ok(result.apps.every((entry) => entry.state === "degraded"));
    if (observation === null || observation.app === "private") {
      assert.ok(result.apps.every((entry) => entry.history.length === 0));
      assert.ok(result.apps.every((entry) => entry.summary.uptimePercent === null));
      assert.ok(result.apps.every((entry) => entry.summary.coveragePercent === 0));
    }
    assert.ok(!JSON.stringify(result).includes("PRIVATE HOST"));
  }
});

void test("declaration failure is sanitized, cached, and drops previously disclosed apps", async () => {
  let calls = 0;
  let now = 130_000;
  const read = createPublicStatusReader(
    client({
      getState: () => {
        calls++;
        return calls === 1 ? Promise.resolve(state()) : Promise.reject(new Error("SECRET"));
      },
    }),
    () => now,
  );
  await read();
  now += 15_000;
  await assert.rejects(read, { message: "Deployment status unavailable", statusCode: 503 });
  await assert.rejects(read, /Deployment status unavailable/u);
  assert.equal(calls, 2);
  const absent = createPublicStatusReader(null, () => now);
  await assert.rejects(absent, /Deployment status unavailable/u);
});

void test("configuration-free public route returns sanitized 503", async () => {
  const app = buildApp(loadApiRuntimeConfig({ NODE_ENV: "test", LOG_LEVEL: "error" }));
  try {
    assert.equal((await app.inject("/deployment/status")).statusCode, 503);
  } finally {
    await app.close();
  }
});
