import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../src/app.js";
import { loadDeployRuntimeConfig } from "../src/config.js";
import type { DokployClient } from "../src/dokploy/client.js";
import type { DokployCompose, DokployProject } from "../src/dokploy/schemas.js";
import { createReconciliationDetector, RECONCILE_INTERVAL_MS } from "../src/reconcile/detection.js";
import { DEPLOY_DESIRED_STATE } from "../src/reconcile/desired-state.gen.js";
import { openServiceTokenStore } from "../src/service-tokens/store.js";

const desired = DEPLOY_DESIRED_STATE.slice(0, 2);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

void test("scheduled reads never mutate, coalesce overlapping polls and clear obsolete success on failure", async () => {
  let time = 100;
  let reads = 0;
  let fail = false;
  let release: ((projects: DokployProject[]) => void) | undefined;
  const detector = createReconciliationDetector(
    {
      getProjects: () => {
        reads += 1;
        if (fail) return Promise.reject(new Error("private upstream value"));
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      getCompose: () => Promise.reject(new Error("no match")),
    },
    desired,
    () => time,
  );
  assert.deepEqual(detector.snapshot(), {
    checkedAt: 100,
    policy: "scheduled-detection-explicit-apply",
    status: "not-checked",
    observedAt: null,
    nextRunAt: null,
    intervalMs: RECONCILE_INTERVAL_MS,
    freshness: "missing",
    results: [],
  });
  const first = detector.poll();
  assert.equal(detector.poll(), first);
  assert.equal(reads, 1);
  assert.equal(detector.snapshot().status, "checking");
  release?.([]);
  await first;
  assert.equal(detector.snapshot().status, "checked");
  assert.equal(detector.snapshot().results.length, desired.length);
  assert.equal(detector.snapshot().freshness, "fresh");
  time += RECONCILE_INTERVAL_MS;
  assert.equal(detector.snapshot().freshness, "stale");
  time = 99;
  assert.equal(detector.snapshot().freshness, "stale");
  time = 200;
  fail = true;
  await detector.poll();
  const failed = detector.snapshot();
  assert.equal(failed.status, "read-failed");
  assert.equal(failed.observedAt, 200);
  assert.deepEqual(
    failed.results,
    desired.map(({ appDir }) => ({ appDir, outcome: "error", reason: "read-failed" })),
  );
  assert.ok(!JSON.stringify(failed).includes("private upstream"));
  fail = false;
  const recovery = detector.poll();
  release?.([]);
  await recovery;
  assert.equal(detector.snapshot().status, "checked");
  await detector.stop();
});

void test("scheduler waits for completion, retries failures and drains shutdown without rescheduling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  let calls = 0;
  let release: ((projects: DokployProject[]) => void) | undefined;
  const detector = createReconciliationDetector(
    {
      getProjects: () => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error("read failed"));
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      getCompose: () => Promise.reject(new Error("no match")),
    },
    desired,
    Date.now,
    100,
  );
  detector.start();
  detector.start();
  assert.equal(calls, 1);
  t.mock.timers.tick(500);
  assert.equal(calls, 1);
  assert.equal(detector.snapshot().nextRunAt, null);
  release?.([]);
  await flush();
  assert.equal(detector.snapshot().nextRunAt, 1_600);
  t.mock.timers.tick(100);
  await flush();
  assert.equal(calls, 2);
  assert.equal(detector.snapshot().status, "read-failed");
  assert.equal(detector.snapshot().nextRunAt, 1_700);
  t.mock.timers.tick(100);
  let closed = false;
  const closing = detector.stop().then(() => {
    closed = true;
  });
  await flush();
  assert.equal(closed, false);
  release?.([]);
  await closing;
  assert.equal(detector.snapshot().nextRunAt, null);
  t.mock.timers.tick(1_000);
  detector.start();
  await detector.poll();
  assert.equal(calls, 3);
});

void test("per-app failures preserve other findings and schema-invalid findings are discarded", async () => {
  const projects: DokployProject[] = [
    {
      projectId: "p",
      name: "p",
      environments: [
        {
          environmentId: "e",
          name: "e",
          compose: [{ composeId: "c", composeStatus: "done", name: desired[0]!.appDir }],
        },
      ],
    },
  ];
  let malformed = false;
  const detector = createReconciliationDetector(
    {
      getProjects: () => Promise.resolve(projects),
      getCompose: () => {
        if (!malformed) return Promise.reject(new Error("private"));
        return Promise.resolve({
          composeId: "c",
          name: "app",
          environmentId: "e",
          sourceType: "github",
          owner: "unimatrixcore",
          repository: "unimatrix-01",
          branch: "bad".repeat(10_000),
          composePath: "wrong",
          autoDeploy: true,
          env: [],
        });
      },
    },
    desired,
  );
  await detector.poll();
  assert.equal(detector.snapshot().status, "read-failed");
  assert.equal(detector.snapshot().results[1]?.outcome, "diffed");
  malformed = true;
  await detector.poll();
  assert.ok(detector.snapshot().results.every((result) => result.outcome === "error"));
  await detector.stop();
});

void test("app listen starts detection and app close waits for the active run", async () => {
  let calls = 0;
  let release: ((projects: DokployProject[]) => void) | undefined;
  const client: DokployClient = {
    getProjects: () => {
      calls += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    getCompose: () => Promise.reject(new Error("unused")),
    getContainers: () => Promise.resolve([]),
    getDokployVersion: () => Promise.reject(new Error("unused")),
    updateComposeSettings: () => Promise.reject(new Error("must never mutate")),
  };
  const app = buildApp(
    loadDeployRuntimeConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "error",
      DEPLOY_DATABASE_PATH: ":memory:",
      DOKPLOY_BASE_URL: "http://dokploy:3000",
      DOKPLOY_API_KEY: "unused",
    }),
    {
      dokploy: client,
      serviceTokens: openServiceTokenStore(":memory:"),
    },
  );
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    assert.equal(calls, 1);
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await flush();
    assert.equal(closed, false);
    release?.([]);
    await closing;
    assert.equal(app.reconciliationDetector.snapshot().nextRunAt, null);
  } finally {
    release?.([]);
    await app.close();
  }
});

void test("scheduled detection includes public routing drift from its existing per-service read", async () => {
  const api = DEPLOY_DESIRED_STATE.find((service) => service.appDir === "api")!;
  let reads = 0;
  let domains: DokployCompose["domains"] = [
    { host: "api.unimatrix-01.dev", https: true, port: 8080, path: "/" },
  ];
  const detector = createReconciliationDetector(
    {
      getProjects: () =>
        Promise.resolve([
          {
            projectId: "p",
            name: "p",
            environments: [
              {
                environmentId: "e",
                name: "e",
                compose: [{ composeId: "c", composeStatus: "done", name: "api" }],
              },
            ],
          },
        ]),
      getCompose: () => {
        reads += 1;
        return Promise.resolve({
          composeId: "c",
          name: "api",
          environmentId: "e",
          composePath: api.composePath,
          sourceType: "github",
          branch: "main",
          autoDeploy: false,
          owner: "unimatrixcore",
          repository: "unimatrix-01",
          env: api.env.map((entry) => ({ key: entry.name, blank: false })),
          ...(domains === undefined ? {} : { domains }),
        });
      },
    },
    [api],
  );
  try {
    await detector.poll();
    assert.equal(reads, 1);
    const result = detector.snapshot().results[0];
    assert.equal(result?.outcome, "diffed");
    if (result?.outcome !== "diffed" || result.diff.verdict !== "matched")
      assert.fail("Expected matched diff");
    assert.equal(result.diff.routing?.status, "drift");
    assert.equal(result.diff.routing?.portMismatch, true);
    assert.equal(result.diff.routing?.declaredPort, 3001);
    assert.equal(result.diff.inSync, false);
    assert.equal(detector.snapshot().status, "checked");
    domains = undefined;
    await detector.poll();
    const unavailable = detector.snapshot().results[0];
    if (unavailable?.outcome !== "diffed" || unavailable.diff.verdict !== "matched")
      assert.fail("Expected matched diff");
    assert.equal(unavailable.diff.routing?.status, "unavailable");
    assert.deepEqual(unavailable.diff.routing?.missingHosts, []);
  } finally {
    await detector.stop();
  }
});
