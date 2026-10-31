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
    getState: () => Promise.resolve(state()),
    getHealth: (app) => Promise.resolve(health(app)),
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
      assert.deepEqual(Object.keys(entry).sort(), ["displayName", "lastCheckedAt", "state"]);
      assert.equal(entry.state, "down");
      assert.equal(entry.lastCheckedAt % 60_000, 0);
    }
    assert.equal((await app.inject("/deployment/status?app=private")).statusCode, 400);
  } finally {
    await app.close();
  }
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
