import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DeployClientError, type DeployClient } from "@unimatrix/deploy-client";
import type { DeployHealthHistoryResponse, DeployReconciliationResponse } from "@unimatrix/shared";

import { buildApp, type BuildApiAppOptions } from "../src/app.js";
import { loadApiRuntimeConfig, type ApiRuntimeEnv } from "../src/config.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CLERK_ENV: ApiRuntimeEnv = {
  CLERK_SECRET_KEY: "sk_test_dummy",
  CLERK_PUBLISHABLE_KEY: "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
  CLERK_JWT_KEY: publicKey.export({ format: "pem", type: "spki" }).toString(),
};
const DEPLOY_ENV: ApiRuntimeEnv = {
  DEPLOY_BASE_URL: "http://deploy.internal:3001",
  DEPLOY_SERVICE_TOKEN: "internal-deploy-token",
};
const attemptId = "00000000-0000-4000-8000-000000000000";
const logsUrl = `/deployment/admin/attempts/logs?app=api&attemptId=${attemptId}`;
const URLS = [
  "/deployment/admin/declarations",
  "/deployment/admin/state",
  "/deployment/admin/health?app=api",
  "/deployment/admin/reconciliation",
  "/deployment/admin/attempts",
  logsUrl,
] as const;

function authHeaders(permissions: Record<string, string[]> = { auth: ["admin"] }) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: "admin-deployment-test-key", typ: "JWT" };
  const payload = {
    azp: "http://localhost",
    exp: issuedAt + 60,
    iat: issuedAt,
    iss: "https://example.clerk.accounts.dev",
    nbf: issuedAt - 5,
    sid: "sess_admin_deployment",
    sub: "user_2cccccccccccccccccccccccccc",
    v: 2,
    permissions,
  };
  const input = [header, payload]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".");
  const signature = createSign("RSA-SHA256").update(input).sign(privateKey, "base64url");
  return { authorization: `Bearer ${input}.${signature}` };
}

function createTestApp(
  env: ApiRuntimeEnv = { ...CLERK_ENV, ...DEPLOY_ENV },
  options: BuildApiAppOptions = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "unimatrix-admin-deployment-"));
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = join(directory, "api.sqlite");
  const app = buildApp(
    loadApiRuntimeConfig({ NODE_ENV: "test", LOG_LEVEL: "error", ...env }),
    options,
  );
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  return {
    app,
    cleanup: async () => {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function health(app: string): DeployHealthHistoryResponse {
  return {
    app,
    current: { app, state: "unknown", checkedAt: null },
    summary: {
      from: 0,
      to: 100,
      upMs: 0,
      downMs: 0,
      unknownMs: 100,
      uptimePercent: null,
      coveragePercent: 0,
    },
    days: [],
    recent: [],
    freshness: "missing",
  };
}

const manualRequest = { app: "api", requestId: "11111111-1111-4111-8111-111111111111" };
const rollbackRequest = {
  ...manualRequest,
  targetAttemptId: "22222222-2222-4222-8222-222222222222",
};
function manualAttempt(
  input = { ...manualRequest, actorUserId: "user_2cccccccccccccccccccccccccc" },
) {
  return {
    ...input,
    id: attemptId,
    repository: "unimatrixcore/unimatrix-01",
    runId: null,
    runAttempt: null,
    trigger: "manual" as const,
    image: null,
    reporterId: "api-service",
    requestedAt: 1,
    deadlineAt: 100,
    baseline: null,
    tagWrite: null,
    queue: "acknowledged" as const,
    queueClaimedAt: 1,
    outcome: "queued" as const,
    correlation: "pending" as const,
    after: null,
    landedAt: null,
    lateLandedAt: null,
  };
}

function client(calls: unknown[] = []): DeployClient {
  return {
    rollback: (input) => {
      calls.push(["rollback", input]);
      return Promise.resolve({
        ...manualAttempt(input),
        ...input,
        trigger: "rollback" as const,
        tagWrite: "acknowledged" as const,
        image: {
          repository: "ghcr.io/unimatrixcore/unimatrix-api",
          tag: "a".repeat(40),
          commit: "a".repeat(40),
          platform: "linux/amd64",
          digestKind: "manifest" as const,
          digest: `sha256:${"b".repeat(64)}`,
        },
      });
    },
    redeploy: (input) => {
      calls.push(["redeploy", input]);
      return Promise.resolve(manualAttempt(input));
    },
    getAttemptLogs: (query) => {
      calls.push(["attempt-logs", query]);
      return Promise.resolve({
        ...query,
        status: "available",
        policy: "recognized-events-only",
        events: ["deployment-failed"],
        withheld: true,
        truncated: false,
      });
    },
    getDeclarations: (query) => {
      calls.push(["declarations", query]);
      return Promise.resolve({ apps: [] });
    },
    getState: (query) => {
      calls.push(["state", query]);
      return Promise.resolve({ checkedAt: 100, apps: [] });
    },
    getHealth: (app) => {
      calls.push(["health", app]);
      return Promise.resolve(health(app));
    },
    getReconciliation: (query) => {
      calls.push(["reconciliation", query]);
      return Promise.resolve({
        checkedAt: 100,
        policy: "scheduled-detection-explicit-apply",
        status: "checked",
        observedAt: 100,
        nextRunAt: 900100,
        intervalMs: 900000,
        freshness: "fresh",
        results: [
          {
            appDir: "api",
            outcome: "diffed",
            diff: {
              appDir: "api",
              verdict: "matched",
              composeId: "compose-api",
              envFindings: [{ key: "API_KEY", state: "set" }],
              settingFindings: [],
              inSync: true,
            },
          },
        ],
      });
    },
    getAttempts: (query) => {
      calls.push(["attempts", query]);
      return Promise.resolve({ attempts: [] });
    },
  };
}

void test("admin deployment routes require both Clerk and deploy-service configuration", async () => {
  for (const env of [{}, CLERK_ENV, DEPLOY_ENV]) {
    const calls: unknown[] = [];
    const { app, cleanup } = createTestApp(env, { deployClient: client(calls) });
    try {
      for (const url of URLS) {
        const response = await app.inject({ url, headers: authHeaders() });
        assert.equal(response.statusCode, 404, url);
      }
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/deployment/admin/redeploy",
            headers: authHeaders(),
            payload: manualRequest,
          })
        ).statusCode,
        404,
      );
      assert.deepEqual(calls, []);
    } finally {
      await cleanup();
    }
  }
});

void test("every admin deployment read rejects anonymous and non-admin sessions before upstream calls", async () => {
  const calls: unknown[] = [];
  const { app, cleanup } = createTestApp(undefined, { deployClient: client(calls) });
  try {
    for (const url of URLS) {
      const anonymous = await app.inject({ url });
      assert.equal(anonymous.statusCode, 401, url);
      assert.equal(anonymous.headers["cache-control"], "no-store");
      assert.equal(
        (await app.inject({ url, headers: authHeaders({ auth: ["editor"] }) })).statusCode,
        403,
        url,
      );
      assert.equal(
        (await app.inject({ url, headers: authHeaders({ admin: ["admin"] }) })).statusCode,
        403,
        url,
      );
    }
    assert.deepEqual(calls, []);
  } finally {
    await cleanup();
  }
});

void test("verified admins receive read responses with validated selectors and no caching", async () => {
  const calls: unknown[] = [];
  const { app, cleanup } = createTestApp(undefined, { deployClient: client(calls) });
  try {
    const headers = authHeaders();
    const urls = [
      "/deployment/admin/declarations?app=api",
      "/deployment/admin/declarations",
      "/deployment/admin/state?app=api",
      "/deployment/admin/health?app=api",
      "/deployment/admin/reconciliation?app=api",
      "/deployment/admin/attempts?app=api&limit=12",
      "/deployment/admin/state",
      "/deployment/admin/reconciliation",
      "/deployment/admin/attempts",
      logsUrl,
    ];
    for (const url of urls) {
      const response = await app.inject({ url, headers });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.doesNotMatch(response.body, /internal-deploy-token|actorUserId|"value"|"env"/u);
      if (url.includes("reconciliation")) {
        const reconciliation = response.json<DeployReconciliationResponse>();
        assert.equal(reconciliation.policy, "scheduled-detection-explicit-apply");
        assert.equal(reconciliation.status, "checked");
        assert.equal(reconciliation.observedAt, 100);
        assert.equal(reconciliation.nextRunAt, 900100);
        assert.equal(reconciliation.intervalMs, 900000);
        assert.equal(reconciliation.freshness, "fresh");
        const result = reconciliation.results[0];
        assert.ok(result?.outcome === "diffed" && result.diff.verdict === "matched");
        assert.deepEqual(result.diff.envFindings, [{ key: "API_KEY", state: "set" }]);
      }
    }
    assert.deepEqual(calls, [
      ["declarations", { app: "api" }],
      ["declarations", {}],
      ["state", { app: "api" }],
      ["health", "api"],
      ["reconciliation", { app: "api" }],
      ["attempts", { app: "api", limit: 12 }],
      ["state", {}],
      ["reconciliation", {}],
      ["attempts", { limit: 50 }],
      ["attempt-logs", { app: "api", attemptId }],
    ]);
  } finally {
    await cleanup();
  }
});

void test("invalid or client-controlled proxy selectors never reach the deployment service", async () => {
  const calls: unknown[] = [];
  const { app, cleanup } = createTestApp(undefined, { deployClient: client(calls) });
  try {
    for (const url of [
      "/deployment/admin/declarations?extra=1",
      "/deployment/admin/declarations?app=../secrets",
      "/deployment/admin/state?app=../secrets",
      "/deployment/admin/state?path=/compose.update",
      "/deployment/admin/state?actorUserId=admin",
      "/deployment/admin/health",
      "/deployment/admin/health?app=api&app=web",
      "/deployment/admin/reconciliation?app=API",
      "/deployment/admin/attempts?limit=101",
      "/deployment/admin/attempts?limit=0",
      "/deployment/admin/attempts?limit=not-a-number",
      "/deployment/admin/attempts?app=api&url=https://example.com",
      "/deployment/admin/attempts/logs?app=api",
      `/deployment/admin/attempts/logs?attemptId=${attemptId}`,
      "/deployment/admin/attempts/logs?app=api&attemptId=invalid",
      `${logsUrl}&url=https://example.com`,
    ]) {
      const response = await app.inject({ url, headers: authHeaders() });
      assert.equal(response.statusCode, 400, url);
      assert.equal(response.headers["cache-control"], "no-store");
    }
    assert.deepEqual(calls, []);
    assert.equal(
      (await app.inject({ method: "POST", url: URLS[0], headers: authHeaders() })).statusCode,
      404,
    );
  } finally {
    await cleanup();
  }
});

void test("upstream failures become generic 502 errors without leaking values to responses or logs", async () => {
  const marker = "upstream-private-value";
  const logs: string[] = [];
  const fail = () => Promise.reject(new Error(marker));
  const deployClient: DeployClient = {
    rollback: fail,
    redeploy: fail,
    getDeclarations: fail,
    getState: fail,
    getHealth: fail,
    getReconciliation: fail,
    getAttempts: fail,
    getAttemptLogs: fail,
  };
  const { app, cleanup } = createTestApp(undefined, {
    deployClient,
    loggerStream: {
      write: (chunk) => {
        logs.push(chunk);
      },
    },
  });
  try {
    for (const url of URLS) {
      const response = await app.inject({ url, headers: authHeaders() });
      assert.equal(response.statusCode, 502, url);
      assert.equal(
        response.json<{ error: { message: string } }>().error.message,
        "Deployment reads unavailable",
      );
      assert.equal(response.headers["cache-control"], "no-store");
      assert.doesNotMatch(response.body, new RegExp(marker, "u"));
    }
    assert.doesNotMatch(logs.join(""), new RegExp(marker, "u"));
  } finally {
    await cleanup();
  }
});

void test("configured transport sends only fixed read paths and its own bearer token, rejecting env-bearing responses", async () => {
  const requests: { url: string | undefined; authorization: string | undefined }[] = [];
  let malformed = false;
  const upstream = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        checkedAt: 100,
        apps: [],
        ...(malformed ? { env: { API_KEY: "upstream-private-value" } } : {}),
      }),
    );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address !== null && typeof address !== "string");
  const logs: string[] = [];
  const { app, cleanup } = createTestApp(
    {
      ...CLERK_ENV,
      ...DEPLOY_ENV,
      DEPLOY_BASE_URL: `http://127.0.0.1:${address.port}`,
    },
    {
      loggerStream: {
        write: (chunk) => {
          logs.push(chunk);
        },
      },
    },
  );
  try {
    const headers = authHeaders();
    const response = await app.inject({ url: "/deployment/admin/state?app=api", headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { checkedAt: 100, apps: [] });
    assert.deepEqual(requests, [
      {
        url: "/deployment/state?app=api",
        authorization: "Bearer internal-deploy-token",
      },
    ]);
    assert.notEqual(requests[0]?.authorization, headers.authorization);

    malformed = true;
    const rejected = await app.inject({ url: "/deployment/admin/state?app=api", headers });
    assert.equal(rejected.statusCode, 502, rejected.body);
    assert.equal(rejected.headers["cache-control"], "no-store");
    assert.doesNotMatch(rejected.body + logs.join(""), /upstream-private-value/u);
    assert.equal(requests.length, 2);
  } finally {
    await cleanup();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

void test("manual redeploy authenticates admins, rejects actor spoofing and forwards verified attribution", async () => {
  const calls: unknown[] = [];
  const { app, cleanup } = createTestApp(undefined, { deployClient: client(calls) });
  const request = {
    method: "POST" as const,
    url: "/deployment/admin/redeploy",
    payload: manualRequest,
  };
  try {
    assert.equal((await app.inject(request)).statusCode, 401);
    assert.equal(
      (await app.inject({ ...request, headers: authHeaders({ auth: ["editor"] }) })).statusCode,
      403,
    );
    for (const payload of [
      { ...manualRequest, actorUserId: "spoofed" },
      { ...manualRequest, composeId: "arbitrary" },
      { ...manualRequest, app: "../api" },
      { ...manualRequest, requestId: "invalid" },
    ]) {
      assert.equal(
        (await app.inject({ ...request, payload, headers: authHeaders() })).statusCode,
        400,
      );
    }
    assert.deepEqual(calls, []);
    const response = await app.inject({ ...request, headers: authHeaders() });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.json(), manualAttempt());
    assert.deepEqual(calls, [
      ["redeploy", { ...manualRequest, actorUserId: "user_2cccccccccccccccccccccccccc" }],
    ]);
  } finally {
    await cleanup();
  }
});

void test("manual redeploy returns safe refusal statuses and hides unknown upstream errors", async () => {
  for (const failure of [
    new DeployClientError(404),
    new DeployClientError(409),
    new Error("private-upstream-value"),
  ]) {
    const logs: string[] = [];
    const deployClient = client();
    deployClient.redeploy = () => Promise.reject(failure);
    const { app, cleanup } = createTestApp(undefined, {
      deployClient,
      loggerStream: {
        write: (chunk) => {
          logs.push(chunk);
        },
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/deployment/admin/redeploy",
        payload: manualRequest,
        headers: authHeaders(),
      });
      assert.equal(
        response.statusCode,
        failure instanceof DeployClientError ? failure.statusCode : 502,
      );
      assert.doesNotMatch(response.body + logs.join(""), /private-upstream-value/u);
    } finally {
      await cleanup();
    }
  }
});

void test("rollback requires deploy admin permission and forwards only verified actor attribution", async () => {
  const calls: unknown[] = [];
  const { app, cleanup } = createTestApp(undefined, { deployClient: client(calls) });
  const request = {
    method: "POST" as const,
    url: "/deployment/admin/rollback",
    payload: rollbackRequest,
  };
  try {
    assert.equal((await app.inject(request)).statusCode, 401);
    assert.equal(
      (await app.inject({ ...request, headers: authHeaders({ auth: ["editor"] }) })).statusCode,
      403,
    );
    for (const payload of [
      { ...rollbackRequest, actorUserId: "spoofed" },
      { ...rollbackRequest, image: { tag: "main" } },
      { ...rollbackRequest, targetAttemptId: "invalid" },
      { ...rollbackRequest, app: "../api" },
    ]) {
      assert.equal(
        (await app.inject({ ...request, payload, headers: authHeaders() })).statusCode,
        400,
      );
    }
    assert.deepEqual(calls, []);
    const response = await app.inject({ ...request, headers: authHeaders() });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.json<{ trigger: string }>().trigger, "rollback");
    assert.deepEqual(calls, [
      ["rollback", { ...rollbackRequest, actorUserId: "user_2cccccccccccccccccccccccccc" }],
    ]);
  } finally {
    await cleanup();
  }
});

void test("rollback preserves safe refusal statuses without leaking upstream values", async () => {
  for (const failure of [
    new DeployClientError(404),
    new DeployClientError(409),
    new Error("private-rollback-value"),
  ]) {
    const logs: string[] = [];
    const deployClient = client();
    deployClient.rollback = () => Promise.reject(failure);
    const { app, cleanup } = createTestApp(undefined, {
      deployClient,
      loggerStream: { write: (chunk) => logs.push(chunk) },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/deployment/admin/rollback",
        payload: rollbackRequest,
        headers: authHeaders(),
      });
      assert.equal(
        response.statusCode,
        failure instanceof DeployClientError ? failure.statusCode : 502,
      );
      assert.doesNotMatch(response.body + logs.join(""), /private-rollback-value/u);
    } finally {
      await cleanup();
    }
  }
});
