import assert from "node:assert/strict";
import test from "node:test";
import type { DeployAttemptRecord } from "@unimatrix/shared";

import { buildApp } from "../src/app.js";
import { attemptDiagnosticLines, readAttemptLogs } from "../src/attempts/logs.js";
import { openDeploymentAttemptStore } from "../src/attempts/store.js";
import { loadDeployRuntimeConfig } from "../src/config.js";
import type { DokployClient } from "../src/dokploy/client.js";
import { createDokployLogClient } from "../src/dokploy/log-client.js";
import { openServiceTokenStore } from "../src/service-tokens/store.js";

const id = "00000000-0000-4000-8000-000000000001";
const image = {
  repository: "ghcr.io/unimatrixcore/unimatrix-api",
  tag: "a".repeat(40),
  commit: "a".repeat(40),
  platform: "linux/amd64",
  digestKind: "manifest" as const,
  digest: `sha256:${"a".repeat(64)}`,
};
const intent = {
  repository: "unimatrixcore/unimatrix-01",
  runId: "42",
  runAttempt: 1,
  app: "api",
  trigger: "ci" as const,
  image,
};
const record: DeployAttemptRecord = {
  ...intent,
  id,
  reporterId: "ci",
  requestedAt: 1,
  deadlineAt: 1_800_001,
  baseline: null,
  tagWrite: "acknowledged",
  queue: "rejected",
  queueClaimedAt: 2,
  outcome: "failed",
  correlation: "pending",
  after: null,
  landedAt: null,
  lateLandedAt: null,
};

void test("durable diagnostics explain rejected, unresolved and late deployment stages without raw output", () => {
  assert.deepEqual(attemptDiagnosticLines(record), [
    "▶ Deployment attempt accepted and recorded.",
    "Immutable target image recorded from CI publication.",
    "No baseline container was recorded; replacement cannot be verified.",
    "Image tag update acknowledged.",
    "✖ Deployment queue request rejected.",
  ]);
  for (const state of ["started", "acknowledged", "rejected", "unknown"] as const) {
    const result = attemptDiagnosticLines({ ...record, tagWrite: state, queue: state });
    assert.equal(result.length, 5);
    assert.equal(
      result.some((line) => line.includes("private-secret")),
      false,
    );
  }
  assert.ok(
    attemptDiagnosticLines({ ...record, outcome: "landed" }).includes(
      "✔ Requested image verified in a replacement container.",
    ),
  );
  assert.ok(
    attemptDiagnosticLines({ ...record, trigger: "rollback" }).includes(
      "Rollback targets a previously verified deployed image.",
    ),
  );
  const manual = {
    ...record,
    trigger: "manual" as const,
    image: null,
    baseline: { containerId: "a".repeat(64), observedAt: 1 },
    tagWrite: null,
    queue: null,
  };
  assert.ok(
    attemptDiagnosticLines({ ...manual, outcome: "recreated" }).includes(
      "✔ Replacement container observed; deployed image remains unverified.",
    ),
  );
  assert.ok(
    attemptDiagnosticLines({ ...manual, outcome: "timed-out", recreatedAt: 3 }).includes(
      "Replacement container observed after the deployment deadline; image remains unverified.",
    ),
  );
  assert.ok(
    attemptDiagnosticLines({ ...record, outcome: "timed-out", lateLandedAt: 3 }).includes(
      "Requested image verified after the deployment deadline.",
    ),
  );
});

function fixture(attemptId = id) {
  const compose = {
    composeId: "compose-api",
    name: "api",
    environmentId: "env",
    composePath: "./infra/docker/api-compose.yaml",
    sourceType: "github",
    branch: "main",
    autoDeploy: false,
    owner: "unimatrixcore",
    repository: "unimatrix-01",
    env: [],
  };
  const client: DokployClient = {
    getProjects: () =>
      Promise.resolve([
        {
          projectId: "project",
          name: "project",
          environments: [
            {
              environmentId: "env",
              name: "env",
              compose: [{ composeId: "compose-api", name: "api", composeStatus: "done" }],
            },
          ],
        },
      ]),
    getCompose: () => Promise.resolve(compose),
    getContainers: () => Promise.resolve([]),
    getDokployVersion: () => Promise.resolve("v0.30.10"),
    updateComposeSettings: () => assert.fail("logs must be read-only"),
  };
  const state = {
    rows: [
      {
        deploymentId: "old-failed",
        composeId: "compose-api",
        title: `unimatrix-attempt:${attemptId}`,
        logPath: "/logs/old.log",
      },
    ],
    text: "Initializing deployment\nError occurred ❌, check the logs for details.\n",
    fail: false,
  };
  const requests: URL[] = [];
  const logs = createDokployLogClient({
    baseUrl: "http://dokploy:3000",
    apiKey: "private-key",
    fetch: (url, options) => {
      assert.equal(options?.method, "GET");
      assert.equal(new Headers(options?.headers).get("x-api-key"), "private-key");
      const parsed = new URL(url instanceof Request ? url.url : url);
      requests.push(parsed);
      if (state.fail) throw new Error("private-upstream-secret");
      if (parsed.pathname === "/api/deployment.allByCompose") {
        assert.equal(parsed.searchParams.get("composeId"), "compose-api");
        return Promise.resolve(Response.json(state.rows));
      }
      assert.equal(parsed.pathname, "/api/deployment.readLogs");
      assert.equal(parsed.searchParams.get("tail"), "101");
      assert.equal(parsed.searchParams.get("deploymentId"), "old-failed");
      return Promise.resolve(Response.json(state.text));
    },
  });
  return { client, compose, state, requests, logs };
}

void test("an older failed attempt retrieves its own source instead of the newest service log", async () => {
  const f = fixture();
  f.state.rows.unshift({
    deploymentId: "newest",
    composeId: "compose-api",
    title: "CI latest",
    logPath: "/logs/latest.log",
  });
  assert.deepEqual(await readAttemptLogs(record, f.client, f.logs), {
    app: "api",
    attemptId: id,
    policy: "recognized-events-only",
    diagnosticLines: attemptDiagnosticLines(record),
    status: "available",
    events: ["deployment-initialized", "deployment-failed"],
    withheld: false,
    truncated: false,
  });
  assert.equal(f.requests.length, 2);
});

void test("association refuses absent, duplicate, foreign, and colliding sources without reading text", async () => {
  for (const scenario of [
    "absent",
    "duplicate",
    "collision",
    "foreign-row",
    "foreign-repo",
    "wrong-compose",
    "empty-path",
  ] as const) {
    const f = fixture();
    let reason = "ambiguous";
    switch (scenario) {
      case "absent":
        f.state.rows[0]!.title = "CI old";
        reason = "unassociated";
        break;
      case "duplicate":
        f.state.rows.push({ ...f.state.rows[0]!, deploymentId: "duplicate", logPath: "/other" });
        break;
      case "collision":
        f.state.rows.push({ ...f.state.rows[0]!, deploymentId: "collision", title: "different" });
        break;
      case "foreign-row":
        f.state.rows[0]!.composeId = "foreign";
        break;
      case "foreign-repo":
        f.compose.owner = "foreign";
        reason = "unassociated";
        break;
      case "wrong-compose":
        f.compose.composeId = "foreign";
        reason = "unassociated";
        break;
      case "empty-path":
        f.state.rows[0]!.logPath = "";
        reason = "source-unavailable";
        break;
    }
    assert.deepEqual(
      await readAttemptLogs(record, f.client, f.logs),
      {
        app: "api",
        attemptId: id,
        policy: "recognized-events-only",
        diagnosticLines: attemptDiagnosticLines(record),
        status: "unavailable",
        reason,
      },
      scenario,
    );
    assert.equal(
      f.requests.some((url) => url.pathname.endsWith("readLogs")),
      false,
      scenario,
    );
  }
  const f = fixture();
  assert.equal(
    (await readAttemptLogs({ ...record, queueClaimedAt: null }, f.client, f.logs)).status,
    "unavailable",
  );
  assert.equal(f.requests.length, 0);
  assert.equal((await readAttemptLogs(record, f.client, undefined)).status, "unavailable");
});

void test("only exact recognized lines survive arbitrary output, controls and credential-shaped values", async () => {
  const f = fixture();
  f.state.text =
    "private-secret\nDocker Compose Deployed: ✅ private-secret\n\u001b[32mDocker Compose Deployed: ✅\nInitializing deployment\nDocker Compose Deployed: ✅\n";
  const result = await readAttemptLogs(record, f.client, f.logs);
  assert.deepEqual(result, {
    app: "api",
    attemptId: id,
    policy: "recognized-events-only",
    diagnosticLines: attemptDiagnosticLines(record),
    status: "available",
    events: ["deployment-initialized", "deployment-completed"],
    withheld: true,
    truncated: false,
  });
  assert.equal(JSON.stringify(result).includes("private-secret"), false);
});

void test("tail overflow is explicit and empty, oversized, malformed or failed upstream output stays unavailable", async () => {
  const f = fixture();
  f.state.text = `${"Docker Compose Deployed: ✅\n".repeat(101)}`;
  const result = await readAttemptLogs(record, f.client, f.logs);
  assert.equal(result.status, "available");
  if (result.status === "available") {
    assert.equal(result.events.length, 100);
    assert.equal(result.truncated, true);
  }
  for (const text of ["", "\n", " \r\n", "x".repeat(262_145), "x".repeat(1_048_577)]) {
    f.state.text = text;
    const unavailable = await readAttemptLogs(record, f.client, f.logs);
    assert.equal(unavailable.status, "unavailable");
    assert.equal(JSON.stringify(unavailable).includes("xxx"), false);
  }
  f.state.fail = true;
  const failed = await readAttemptLogs(record, f.client, f.logs);
  assert.equal(JSON.stringify(failed).includes("private-upstream-secret"), false);
  assert.equal(failed.status, "unavailable");
  f.state.fail = false;
  f.state.rows[0]!.deploymentId = "invalid/private-secret";
  assert.equal((await readAttemptLogs(record, f.client, f.logs)).status, "unavailable");
});

void test("HTTP log reads authenticate, validate exact selection, and preserve no-store output", async () => {
  const now = Date.now();
  const store = openDeploymentAttemptStore(":memory:");
  const attempt = store.intent(intent, "ci", null, now);
  for (const stage of ["tag-write", "queue"] as const) {
    store.report({ attemptId: attempt.id, stage, result: "started" }, "ci", now);
    store.report({ attemptId: attempt.id, stage, result: "acknowledged" }, "ci", now);
  }
  const f = fixture(attempt.id);
  const tokens = openServiceTokenStore(":memory:");
  const token = tokens.issue({ name: "reader", capability: "read" }).token;
  const app = buildApp(
    loadDeployRuntimeConfig({
      NODE_ENV: "test",
      DEPLOY_DATABASE_PATH: ":memory:",
      DOKPLOY_BASE_URL: "http://unused",
      DOKPLOY_API_KEY: "unused",
    }),
    {
      dokploy: f.client,
      deploymentLogs: f.logs,
      deploymentAttempts: store,
      serviceTokens: tokens,
      readRuntimeEvidence: () => Promise.resolve([]),
    },
  );
  try {
    const url = `/deployment/attempts/logs?app=api&attemptId=${attempt.id}`;
    assert.equal((await app.inject({ url })).statusCode, 401);
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await app.inject({ url: `${url}&path=private`, headers })).statusCode, 400);
    assert.equal(
      (await app.inject({ url: "/deployment/attempts/logs?app=api&attemptId=invalid", headers }))
        .statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ url: url.replace("app=api", "app=auth"), headers })).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ url: `/deployment/attempts/logs?app=api&attemptId=${id}`, headers }))
        .statusCode,
      404,
    );
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.json<{ status: string }>().status, "available");
  } finally {
    await app.close();
  }
});
