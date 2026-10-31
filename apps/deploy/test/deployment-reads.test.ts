import assert from "node:assert/strict";
import test from "node:test";

import type {
  DeployStateResponse,
  DeployHealthHistoryResponse,
  DeployReconciliationResponse,
} from "@unimatrix/shared";

import { buildApp } from "../src/app.js";
import { loadDeployRuntimeConfig } from "../src/config.js";
import { createDokployClient, type DokployClient } from "../src/dokploy/client.js";
import type { DokployCompose, DokployProject } from "../src/dokploy/schemas.js";
import { setupHealthMonitoring } from "../src/health-history/lifecycle.js";
import { PROBE_INTERVAL_MS } from "../src/health-history/model.js";
import { CONTAINER_POLL_INTERVAL_MS } from "../src/observe/polling.js";
import { DEPLOY_DESIRED_STATE } from "../src/reconcile/desired-state.gen.js";
import { openServiceTokenStore } from "../src/service-tokens/store.js";

const NOW = 1_800_000_000_000;
const CANARY = "secret-canary-never-return-or-log";
const PATHS = ["/deployment/state", "/deployment/health?app=api", "/deployment/reconciliation"];

function projects(names: readonly string[]): DokployProject[] {
  return [
    {
      projectId: "project",
      name: "project",
      environments: [
        {
          environmentId: "environment",
          name: "environment",
          compose: names.map((name, index) => ({
            composeId: `compose-${String(index)}`,
            composeStatus: "done",
            name,
          })),
        },
      ],
    },
  ];
}

function compose(): DokployCompose {
  return {
    composeId: "compose-0",
    name: "api",
    environmentId: "environment",
    composePath: "infra/docker/api-compose.yaml",
    sourceType: "github",
    branch: "main",
    autoDeploy: false,
    owner: "unimatrixcore",
    repository: "unimatrix-01",
    env: DEPLOY_DESIRED_STATE.find((service) => service.appDir === "api")!.env.map(({ name }) => ({
      key: name,
      blank: false,
    })),
  };
}

function fixture(withHealth = true, suppliedClient?: DokployClient) {
  const calls = { containers: 0, projects: 0, compose: 0, mutation: 0 };
  const client: DokployClient = suppliedClient ?? {
    getDokployVersion: () => Promise.reject(new Error("unused")),
    getContainers: () => {
      calls.containers += 1;
      return Promise.resolve([
        {
          containerId: "container-1",
          name: "api",
          image: "ghcr.io/unimatrixcore/unimatrix-api:main",
          state: "running",
          status: "Up 1 minute",
          ports: "3001/tcp",
        },
      ]);
    },
    getProjects: () => {
      calls.projects += 1;
      return Promise.resolve(projects(["api"]));
    },
    getCompose: () => {
      calls.compose += 1;
      return Promise.resolve(compose());
    },
    updateComposeSettings: () => {
      calls.mutation += 1;
      return Promise.reject(new Error("read routes must never mutate"));
    },
  };
  const tokens = openServiceTokenStore(":memory:");
  const read = tokens.issue({ name: "read", capability: "read" }).token;
  const manage = tokens.issue({ name: "manage", capability: "manage" }).token;
  const revoked = tokens.issue({ name: "revoked", capability: "read" }).token;
  tokens.revoke("revoked");
  const logs: string[] = [];
  const app = buildApp(
    loadDeployRuntimeConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      DEPLOY_DATABASE_PATH: ":memory:",
      DOKPLOY_BASE_URL: "http://dokploy:3000",
      DOKPLOY_API_KEY: "unused-test-key",
    }),
    {
      dokploy: client,
      serviceTokens: tokens,
      loggerStream: {
        write: (chunk) => {
          logs.push(chunk);
        },
      },
    },
  );
  if (withHealth)
    setupHealthMonitoring(
      app,
      ":memory:",
      DEPLOY_DESIRED_STATE.map(({ appDir }) => ({
        app: appDir,
        configured: false,
        url: "http://unused/health",
      })),
    );
  const headers = { authorization: `Bearer ${read}` };
  return { app, client, calls, read, manage, revoked, logs, headers };
}

void test("deployment reads reject missing, invalid and revoked credentials before data access", async () => {
  const { app, calls, revoked } = fixture();
  try {
    for (const url of PATHS) {
      for (const authorization of [undefined, "Bearer invalid", `Bearer ${revoked}`]) {
        const response = await app.inject({
          url,
          ...(authorization ? { headers: { authorization } } : {}),
        });
        assert.equal(response.statusCode, 401);
      }
    }
    assert.deepEqual(calls, { containers: 0, projects: 0, compose: 0, mutation: 0 });
  } finally {
    await app.close();
  }
});

void test("read and manage callers can use every deployment read without mutations", async () => {
  const { app, read, manage, calls } = fixture();
  try {
    for (const token of [read, manage]) {
      for (const url of PATHS) {
        const response = await app.inject({ url, headers: { authorization: `Bearer ${token}` } });
        assert.equal(response.statusCode, 200, response.body);
        assert.match(String(response.headers["cache-control"]), /no-store/u);
      }
    }
    assert.equal(calls.mutation, 0);
    assert.equal(calls.containers, 0);
    assert.equal((await app.inject("/health")).statusCode, 200);
  } finally {
    await app.close();
  }
});

void test("query validation and unknown apps fail before upstream reads", async () => {
  const { app, headers, calls } = fixture();
  try {
    for (const url of [
      "/deployment/state?extra=1",
      "/deployment/state?app=",
      "/deployment/health",
      "/deployment/health?app=api&extra=1",
      "/deployment/reconciliation?extra=1",
      "/deployment/reconciliation?app=api&app=admin",
    ])
      assert.equal((await app.inject({ url, headers })).statusCode, 400, url);
    for (const path of ["state", "health", "reconciliation"]) {
      assert.equal(
        (await app.inject({ url: `/deployment/${path}?app=nonexistent`, headers })).statusCode,
        404,
      );
    }
    assert.deepEqual(calls, { containers: 0, projects: 0, compose: 0, mutation: 0 });
  } finally {
    await app.close();
  }
});

void test("state reads preserve missing, fresh and stale observations without polling", async (context) => {
  let now = NOW;
  context.mock.method(Date, "now", () => now);
  const { app, headers, calls } = fixture();
  try {
    const read = async () =>
      (await app.inject({ url: "/deployment/state?app=api", headers })).json<DeployStateResponse>();
    const missing = await read();
    assert.equal(missing.apps.length, 1);
    assert.equal(missing.apps[0]!.container.freshness, "missing");
    const missingContainer = missing.apps[0]!.container;
    assert.equal(missingContainer.kind, "unknown");
    assert.ok(missingContainer.kind === "unknown");
    assert.equal(missingContainer.reason, "not-polled");
    await app.containerObserver.poll();
    const fresh = await read();
    assert.equal(fresh.checkedAt, NOW);
    assert.equal(fresh.apps[0]!.publicStatus, true);
    assert.equal(fresh.apps[0]!.container.freshness, "fresh");
    assert.equal(fresh.apps[0]!.container.kind, "matched");
    now += CONTAINER_POLL_INTERVAL_MS + 1;
    assert.equal((await read()).apps[0]!.container.freshness, "stale");
    app.containerObserver.getSnapshot = () => [
      { appDir: "api", kind: "unknown", reason: "poll-failed", observedAt: now },
    ];
    assert.equal((await read()).apps[0]!.container.kind, "unknown");
    app.containerObserver.getSnapshot = () => [];
    assert.equal((await read()).apps[0]!.container.freshness, "missing");
    assert.equal(calls.containers, 1);
  } finally {
    await app.close();
  }
});

void test("health reads distinguish missing, down, fresh unknown and stale samples and bound history", async (context) => {
  let now = NOW;
  context.mock.method(Date, "now", () => now);
  const { app, headers } = fixture();
  try {
    const read = async () =>
      (
        await app.inject({ url: "/deployment/health?app=api", headers })
      ).json<DeployHealthHistoryResponse>();
    const missing = await read();
    assert.equal(missing.freshness, "missing");
    assert.equal(missing.current.checkedAt, null);
    for (let index = 120; index >= 0; index -= 1) {
      const checkedAt = NOW - index * PROBE_INTERVAL_MS;
      app.healthHistory.record({ app: "api", checkedAt, state: "down" }, checkedAt);
    }
    const down = await read();
    assert.equal(down.current.state, "down");
    assert.equal(down.freshness, "fresh");
    assert.equal(down.days.length, 30);
    assert.equal(down.recent.length, 60);
    now += PROBE_INTERVAL_MS;
    const stale = await read();
    assert.equal(stale.freshness, "stale");
    assert.equal(stale.current.state, "unknown");
    assert.equal(stale.current.checkedAt, NOW);
    app.healthHistory.record({ app: "api", checkedAt: now, state: "unknown" }, now);
    const unknown = await read();
    assert.equal(unknown.freshness, "fresh");
    assert.equal(unknown.current.state, "unknown");
  } finally {
    await app.close();
  }
});

void test("missing health persistence returns a generic unavailable response", async () => {
  const { app, headers } = fixture(false);
  try {
    const response = await app.inject({ url: "/deployment/health?app=api", headers });
    assert.equal(response.statusCode, 503);
    assert.ok(!response.body.includes("healthHistory"));
  } finally {
    await app.close();
  }
});

void test("reconciliation HTTP reads expose cached metadata without triggering Dokploy calls", async () => {
  const { app, client, headers, calls } = fixture();
  try {
    const read = () => app.inject({ url: "/deployment/reconciliation?app=api", headers });
    const initial = (await read()).json<DeployReconciliationResponse>();
    assert.equal(initial.status, "not-checked");
    assert.equal(initial.freshness, "missing");
    assert.equal(initial.observedAt, null);
    assert.deepEqual(initial.results, []);
    assert.equal(calls.projects, 0);
    await app.reconciliationDetector.poll();
    const cached = (await read()).json<DeployReconciliationResponse>();
    assert.equal(cached.policy, "scheduled-detection-explicit-apply");
    assert.equal(cached.status, "checked");
    assert.equal(cached.results.length, 1);
    client.getProjects = () => Promise.reject(new Error("must not read on request"));
    assert.deepEqual((await read()).json<DeployReconciliationResponse>().results, cached.results);
    assert.equal(calls.projects, 1);
    assert.equal(calls.mutation, 0);
    app.reconciliationDetector.snapshot = () => {
      throw new Error(CANARY);
    };
    const failed = await read();
    assert.equal(failed.statusCode, 503);
    assert.ok(!failed.body.includes(CANARY));
  } finally {
    await app.close();
  }
});

void test("reconciliation reads expose missing, ambiguous, drift and sanitized per-app failure", async () => {
  const { app, client, headers, calls, logs } = fixture();
  try {
    const read = async () =>
      (
        await app.inject({ url: "/deployment/reconciliation?app=api", headers })
      ).json<DeployReconciliationResponse>();
    const readDiff = async () => {
      await app.reconciliationDetector.poll();
      const result = (await read()).results[0]!;
      assert.ok(result.outcome === "diffed");
      return result.diff;
    };
    client.getProjects = () => Promise.resolve([]);
    assert.equal((await readDiff()).verdict, "missing");
    client.getProjects = () => Promise.resolve(projects(["api", "api"]));
    assert.equal((await readDiff()).verdict, "ambiguous");
    client.getProjects = () => Promise.resolve(projects(["api"]));
    client.getCompose = () =>
      Promise.resolve({
        ...compose(),
        branch: "wrong-branch",
        env: [{ key: "IMAGE_TAG", blank: true }],
      });
    const drift = await readDiff();
    assert.ok(drift.verdict === "matched");
    assert.equal(drift.inSync, false);
    assert.ok(
      drift.settingFindings.some((finding: { setting: string }) => finding.setting === "branch"),
    );
    assert.ok(drift.envFindings.some((finding: { state: string }) => finding.state === "blank"));
    client.getCompose = () => Promise.reject(new Error(CANARY));
    await app.reconciliationDetector.poll();
    const failure = await read();
    assert.deepEqual(failure.results, [{ appDir: "api", outcome: "error", reason: "read-failed" }]);
    assert.ok(!JSON.stringify(failure).includes(CANARY));
    assert.ok(!logs.join("").includes(CANARY));
    assert.equal(calls.mutation, 0);
  } finally {
    await app.close();
  }
});

void test("upstream failures and oversized output produce safe unavailable responses", async () => {
  const { app, client, headers, logs } = fixture();
  try {
    client.getProjects = () => Promise.reject(new Error(CANARY));
    await app.reconciliationDetector.poll();
    const unavailable = await app.inject({ url: "/deployment/reconciliation", headers });
    assert.equal(unavailable.statusCode, 200);
    assert.equal(unavailable.json<DeployReconciliationResponse>().status, "read-failed");
    assert.ok(!unavailable.body.includes(CANARY));
    app.containerObserver.getSnapshot = () => [
      {
        appDir: "api",
        kind: "matched",
        observedAt: Date.now(),
        containerId: "id",
        image: CANARY.repeat(100_000),
        state: "running",
        status: "Up",
        containerAgeMs: null,
        firstObservedAt: Date.now(),
        lastRecreatedAt: null,
      },
    ];
    const oversized = await app.inject({ url: "/deployment/state?app=api", headers });
    assert.equal(oversized.statusCode, 503);
    assert.ok(!oversized.body.includes(CANARY));
    assert.ok(!logs.join("").includes(CANARY));
  } finally {
    await app.close();
  }
});

void test("Dokploy plaintext env values never cross reconciliation HTTP or logging boundaries", async () => {
  let env = `IMAGE_TAG=main\nCLERK_SECRET_KEY=${CANARY}\n`;
  const client = createDokployClient({
    baseUrl: "http://dokploy:3000",
    apiKey: CANARY,
    fetch: (url) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            (url as URL).toString().includes("project.all")
              ? projects(["api"]).map((project) => ({
                  ...project,
                  env: `PROJECT_SECRET=${CANARY}`,
                }))
              : { ...compose(), env },
          ),
          { headers: { "content-type": "application/json" } },
        ),
      ),
  });
  const { app, headers, logs } = fixture(true, client);
  try {
    await app.reconciliationDetector.poll();
    const response = await app.inject({ url: "/deployment/reconciliation?app=api", headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.body.includes("CLERK_SECRET_KEY"));
    assert.ok(!response.body.includes(CANARY));
    for (const unsupported of [
      `SECRET="first\n${CANARY}=payload\nlast"`,
      `SECRET='first\n${CANARY}=payload\nlast'`,
      `${CANARY} invalid key=value`,
    ]) {
      env = unsupported;
      await app.reconciliationDetector.poll();
      const refused = await app.inject({ url: "/deployment/reconciliation?app=api", headers });
      assert.equal(refused.statusCode, 200);
      assert.deepEqual(refused.json<DeployReconciliationResponse>().results, [
        { appDir: "api", outcome: "error", reason: "read-failed" },
      ]);
      assert.ok(!refused.body.includes(CANARY));
    }
    assert.ok(!logs.join("").includes(CANARY));
  } finally {
    await app.close();
  }
});
