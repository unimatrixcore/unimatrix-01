import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDeployClient, DeployClientError, type DeployClientConfig } from "../src/index.js";

const state = { checkedAt: 123, apps: [] };
const summary = {
  from: 0,
  to: 123,
  upMs: 0,
  downMs: 0,
  unknownMs: 123,
  uptimePercent: null,
  coveragePercent: 0,
};
const health = {
  app: "api",
  current: { app: "api", state: "unknown", checkedAt: null },
  summary,
  days: [],
  recent: [],
  freshness: "missing",
};
let server: Server;
let baseUrl: string;
let mode = "ok";
let selectedResponse: unknown;
let wireRequests: { method: string | undefined; body: string; contentType: string | undefined }[] =
  [];
let requests: { url: string | undefined; authorization: string | undefined }[];

beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () =>
      wireRequests.push({
        method: request.method,
        body: Buffer.concat(chunks).toString("utf8"),
        contentType: request.headers["content-type"],
      }),
    );
    if (mode === "not-found" || mode === "conflict") {
      response.writeHead(mode === "not-found" ? 404 : 409);
      response.end("private upstream text");
      return;
    }
    if (mode === "timeout") return;
    if (mode === "body-timeout") {
      response.writeHead(200);
      response.write("{");
      return;
    }
    if (mode === "reset") {
      request.socket.destroy();
      return;
    }
    if (mode === "truncated") {
      response.writeHead(200, { "content-length": "1000" });
      response.write("{");
      setImmediate(() => response.destroy());
      return;
    }
    if (mode === "redirect") {
      response.writeHead(302, { location: `${baseUrl}/leak` });
      response.end("private upstream text");
      return;
    }
    response.writeHead(mode === "error" ? 500 : 200);
    response.end(
      mode === "oversize"
        ? "x".repeat(1_048_577)
        : mode === "json"
          ? "private upstream text"
          : mode === "schema"
            ? JSON.stringify({ secret: "private upstream text" })
            : JSON.stringify(
                mode === "selected"
                  ? selectedResponse
                  : request.url?.startsWith("/deployment/state")
                    ? state
                    : {
                        ...health,
                        ...(mode === "wrong-app" ? { app: "other" } : {}),
                        ...(mode === "wrong-current"
                          ? { current: { ...health.current, app: "other" } }
                          : {}),
                        ...(mode === "wrong-recent"
                          ? { recent: [{ app: "other", checkedAt: 123, state: "up" }] }
                          : {}),
                      },
              ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected listener address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
});

function client(options: Partial<DeployClientConfig> = {}) {
  return createDeployClient({ baseUrl, serviceToken: "test-token", ...options });
}

describe("deployment transport", () => {
  it("posts only authenticated manual redeploy inputs and validates returned attribution", async () => {
    mode = "selected";
    requests = [];
    wireRequests = [];
    const input = {
      app: "api",
      requestId: "11111111-1111-4111-8111-111111111111",
      actorUserId: "verified-user",
    };
    const attempt = {
      ...input,
      id: "00000000-0000-4000-8000-000000000000",
      repository: "unimatrixcore/unimatrix-01",
      runId: null,
      runAttempt: null,
      trigger: "manual",
      image: null,
      reporterId: "api-service",
      requestedAt: 1,
      deadlineAt: 100,
      baseline: null,
      tagWrite: null,
      queue: "acknowledged",
      queueClaimedAt: 1,
      outcome: "queued",
      correlation: "pending",
      after: null,
      landedAt: null,
      lateLandedAt: null,
    };
    selectedResponse = attempt;
    expect(await client().redeploy(input)).toEqual(attempt);
    expect(requests).toEqual([{ url: "/deployment/redeploy", authorization: "Bearer test-token" }]);
    expect(wireRequests).toEqual([
      { method: "POST", contentType: "application/json", body: JSON.stringify(input) },
    ]);
    const recreated = {
      ...attempt,
      baseline: { containerId: "a".repeat(64), observedAt: 1 },
      outcome: "recreated",
      recreatedAt: 2,
      after: {
        containerId: "b".repeat(64),
        observedAt: 2,
        image: {
          repository: "ghcr.io/unimatrixcore/unimatrix-api",
          platform: "linux/amd64",
          digestKind: "manifest",
          digest: `sha256:${"c".repeat(64)}`,
        },
      },
    };
    selectedResponse = recreated;
    expect(await client().redeploy(input)).toEqual(recreated);
    for (const invalid of [
      { ...attempt, app: "web" },
      { ...attempt, actorUserId: "another-user" },
      { ...attempt, requestId: "22222222-2222-4222-8222-222222222222" },
      { ...attempt, env: "private upstream text" },
    ]) {
      selectedResponse = invalid;
      await expect(client().redeploy(input)).rejects.toBeInstanceOf(DeployClientError);
    }
    requests = [];
    for (const invalid of [
      { ...input, composeId: "arbitrary-id" },
      { ...input, app: "../api" },
      { ...input, actorUserId: "" },
    ])
      await expect(client().redeploy(invalid)).rejects.toBeInstanceOf(DeployClientError);
    expect(requests).toHaveLength(0);
    for (const [failure, statusCode] of [
      ["not-found", 404],
      ["conflict", 409],
      ["error", undefined],
      ["redirect", undefined],
      ["timeout", undefined],
    ] as const) {
      mode = failure;
      requests = [];
      let error: unknown;
      try {
        await client({ timeoutMs: 50 }).redeploy(input);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(DeployClientError);
      expect(error).toHaveProperty("statusCode", statusCode);
      expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toContain("private upstream text");
      expect(requests).toHaveLength(1);
    }
  });

  it("selects exact attempt logs and rejects mismatched, raw or unbounded output", async () => {
    mode = "selected";
    requests = [];
    const query = { app: "api", attemptId: "00000000-0000-4000-8000-000000000000" };
    const output = {
      ...query,
      status: "available",
      policy: "recognized-events-only",
      events: ["deployment-failed"],
      withheld: true,
      truncated: true,
    };
    selectedResponse = output;
    expect(await client().getAttemptLogs(query)).toEqual(output);
    expect(requests).toEqual([
      {
        url: `/deployment/attempts/logs?app=api&attemptId=${query.attemptId}`,
        authorization: "Bearer test-token",
      },
    ]);
    for (const invalid of [
      { ...output, app: "web" },
      { ...output, attemptId: "11111111-1111-4111-8111-111111111111" },
      { ...output, text: "private credential" },
      { ...output, events: ["private credential"] },
      { ...output, events: Array.from({ length: 101 }, () => "deployment-failed") },
    ]) {
      selectedResponse = invalid;
      await expect(client().getAttemptLogs(query)).rejects.toThrow("Deployment read unavailable");
    }
    const unavailable = {
      ...query,
      status: "unavailable",
      policy: "recognized-events-only",
      reason: "source-unavailable",
    };
    selectedResponse = unavailable;
    expect(await client().getAttemptLogs(query)).toEqual(unavailable);
    requests = [];
    for (const invalid of [
      { ...query, app: "../private" },
      { ...query, attemptId: "invalid" },
    ]) {
      await expect(client().getAttemptLogs(invalid)).rejects.toBeInstanceOf(DeployClientError);
    }
    expect(requests).toHaveLength(0);
    mode = "error";
    await expect(client().getAttemptLogs(query)).rejects.toThrow("Deployment read unavailable");
  });
  it("rejects declaration records for another app and credential-bearing sources", async () => {
    requests = [];
    mode = "selected";
    const declaration = {
      appDir: "api",
      packageName: "@unimatrix/api",
      kind: "node-api",
      configPath: "apps/api/deploy.config.ts",
      composePath: "infra/docker/api-compose.yaml",
      image: "ghcr.io/unimatrixcore/api",
      containerPort: 3001,
      publicStatus: true,
      healthProbe: { url: "http://api:3001/health" },
      env: [
        {
          name: "KEY",
          source: {
            kind: "secrets-store",
            name: "KEY",
            secretName: "platform/key",
            required: true,
          },
        },
      ],
      buildArgs: [],
      dockerfileEnv: [],
    };
    selectedResponse = { apps: [declaration] };
    expect((await client().getDeclarations({ app: "api" })).apps).toHaveLength(1);
    await expect(client().getDeclarations({ app: "web" })).rejects.toBeInstanceOf(
      DeployClientError,
    );
    selectedResponse = {
      apps: [
        {
          ...declaration,
          env: [
            { name: "KEY", source: { ...declaration.env[0]?.source, value: "private credential" } },
          ],
        },
      ],
    };
    await expect(client().getDeclarations()).rejects.toThrow("Deployment read unavailable");
  });

  it("reads selected state, reconciliation and bounded attempt history through static paths", async () => {
    mode = "selected";
    requests = [];
    selectedResponse = { apps: [] };
    expect(await client().getDeclarations({ app: "api" })).toEqual({ apps: [] });
    expect(await client().getDeclarations()).toEqual({ apps: [] });
    selectedResponse = state;
    expect(await client().getState({ app: "api" })).toEqual(state);
    const reconciliation = {
      checkedAt: 123,
      policy: "scheduled-detection-explicit-apply",
      status: "checked",
      observedAt: 100,
      nextRunAt: 900100,
      intervalMs: 900000,
      freshness: "fresh",
      results: [],
    };
    selectedResponse = reconciliation;
    expect(await client().getReconciliation({ app: "api" })).toEqual(reconciliation);
    expect(await client().getReconciliation()).toEqual(reconciliation);
    selectedResponse = { attempts: [] };
    expect(await client().getAttempts({ app: "api", limit: 3 })).toEqual({ attempts: [] });
    expect(await client().getAttempts()).toEqual({ attempts: [] });
    expect(requests).toEqual([
      { url: "/deployment/declarations?app=api", authorization: "Bearer test-token" },
      { url: "/deployment/declarations", authorization: "Bearer test-token" },
      { url: "/deployment/state?app=api", authorization: "Bearer test-token" },
      { url: "/deployment/reconciliation?app=api", authorization: "Bearer test-token" },
      { url: "/deployment/reconciliation", authorization: "Bearer test-token" },
      { url: "/deployment/attempts?app=api&limit=3", authorization: "Bearer test-token" },
      { url: "/deployment/attempts?limit=50", authorization: "Bearer test-token" },
    ]);
    for (const operation of [
      () => client().getDeclarations({ app: "../private" }),
      () => client().getState({ app: "../private" }),
      () => client().getReconciliation({ app: "../private" }),
      () => client().getAttempts({ app: "../private" }),
      () => client().getAttempts({ limit: 0 }),
      () => client().getAttempts({ limit: 101 }),
    ]) {
      await expect(operation()).rejects.toBeInstanceOf(DeployClientError);
    }
    expect(requests).toHaveLength(7);
  });

  it("rejects state and reconciliation records outside their selected app or parent", async () => {
    mode = "selected";
    const container = {
      appDir: "api",
      kind: "unknown",
      reason: "not-polled",
      observedAt: null,
      freshness: "missing",
    };
    selectedResponse = {
      checkedAt: 123,
      apps: [{ appDir: "api", publicStatus: false, container }],
    };
    expect((await client().getState({ app: "api" })).apps).toHaveLength(1);
    await expect(client().getState({ app: "web" })).rejects.toBeInstanceOf(DeployClientError);
    selectedResponse = {
      checkedAt: 123,
      apps: [{ appDir: "api", publicStatus: false, container: { ...container, appDir: "web" } }],
    };
    await expect(client().getState()).rejects.toBeInstanceOf(DeployClientError);
    for (const result of [
      { appDir: "web", outcome: "error", reason: "read-failed" },
      { appDir: "web", outcome: "diffed", diff: { appDir: "web", verdict: "missing" } },
      { appDir: "api", outcome: "diffed", diff: { appDir: "web", verdict: "missing" } },
    ]) {
      selectedResponse = {
        checkedAt: 123,
        policy: "scheduled-detection-explicit-apply",
        status: "checked",
        observedAt: 100,
        nextRunAt: 900100,
        intervalMs: 900000,
        freshness: "fresh",
        results: [result],
      };
      await expect(client().getReconciliation({ app: "api" })).rejects.toBeInstanceOf(
        DeployClientError,
      );
    }
    selectedResponse = {
      checkedAt: 123,
      policy: "scheduled-detection-explicit-apply",
      status: "checked",
      observedAt: 100,
      nextRunAt: 900100,
      intervalMs: 900000,
      freshness: "fresh",
      results: [{ appDir: "api", outcome: "diffed", diff: { appDir: "api", verdict: "missing" } }],
    };
    expect((await client().getReconciliation({ app: "api" })).results).toHaveLength(1);
  });

  it("rejects attempt records outside their selected app or requested limit", async () => {
    mode = "selected";
    const attempt = {
      id: "00000000-0000-4000-8000-000000000000",
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
      reporterId: "ci",
      requestedAt: 1,
      deadlineAt: 100,
      baseline: null,
      tagWrite: null,
      queue: null,
      queueClaimedAt: null,
      outcome: "incomplete",
      correlation: "pending",
      after: null,
      landedAt: null,
      lateLandedAt: null,
    };
    selectedResponse = { attempts: [attempt] };
    expect(await client().getAttempts({ app: "api", limit: 1 })).toEqual(selectedResponse);
    await expect(client().getAttempts({ app: "web" })).rejects.toBeInstanceOf(DeployClientError);
    selectedResponse = { attempts: [attempt, attempt] };
    await expect(client().getAttempts({ limit: 1 })).rejects.toBeInstanceOf(DeployClientError);
  });

  it("authenticates static contract reads and validates health selection", async () => {
    mode = "ok";
    requests = [];
    expect(await client().getState()).toEqual(state);
    expect(await client().getHealth("api")).toEqual(health);
    expect(requests).toEqual([
      { url: "/deployment/state", authorization: "Bearer test-token" },
      { url: "/deployment/health?app=api", authorization: "Bearer test-token" },
    ]);
    await expect(client().getHealth("../private")).rejects.toBeInstanceOf(DeployClientError);
    expect(requests).toHaveLength(2);
  });

  it("discards upstream and transport error details and refuses redirects", async () => {
    for (const failure of [
      "error",
      "json",
      "schema",
      "reset",
      "truncated",
      "oversize",
      "redirect",
      "timeout",
      "body-timeout",
    ]) {
      mode = failure;
      requests = [];
      let error: unknown;
      try {
        await client({ timeoutMs: 50 }).getState();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(DeployClientError);
      expect(String(error)).toBe("DeployClientError: Deployment read unavailable");
      expect(error).not.toHaveProperty("cause");
      expect(requests).toHaveLength(1);
    }
  });

  it("rejects health observations belonging to another app", async () => {
    for (const failure of ["wrong-app", "wrong-current", "wrong-recent"]) {
      mode = failure;
      requests = [];
      await expect(client().getHealth("api")).rejects.toBeInstanceOf(DeployClientError);
    }
  });

  it("refuses malformed origins, tokens, deadlines and mismatched TLS configuration", () => {
    for (const options of [
      { baseUrl: "not-a-url" },
      { baseUrl: "ftp://localhost" },
      { baseUrl: "http://user:pass@localhost" },
      { baseUrl: "http://localhost/path" },
      { baseUrl: "http://localhost?query=1" },
      { baseUrl: "http://localhost#hash" },
      { baseUrl: "https://localhost" },
      { caCertificatePem: "unused" },
      { serviceToken: " " },
      { serviceToken: "token\r\nheader" },
      { timeoutMs: 0 },
      { timeoutMs: 1.5 },
    ])
      expect(() => client(options)).toThrow(DeployClientError);
  });
});

// RSA fixture generation can exceed five seconds during hosted-runner builds.
it("pins the live TLS certificate, verifies hostname, and sends no token after failed handshakes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deploy-client-tls-"));
  function pair(name: string) {
    const key = join(directory, `${name}.key`);
    const cert = join(directory, `${name}.pem`);
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
  }
  const matching = pair("matching");
  const other = pair("other");
  const seen: string[] = [];
  const tlsServer = createTlsServer(matching, (request, response) => {
    seen.push(request.headers.authorization ?? "");
    response.end(JSON.stringify(state));
  });
  try {
    await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
    const address = tlsServer.address();
    if (!address || typeof address === "string") throw new Error("Expected listener address");
    const url = `https://localhost:${address.port}`;
    expect(await client({ baseUrl: url, caCertificatePem: matching.cert }).getState()).toEqual(
      state,
    );
    await expect(
      client({ baseUrl: url, caCertificatePem: other.cert }).getState(),
    ).rejects.toBeInstanceOf(DeployClientError);
    await expect(
      client({
        baseUrl: `https://127.0.0.1:${address.port}`,
        caCertificatePem: matching.cert,
      }).getState(),
    ).rejects.toBeInstanceOf(DeployClientError);
    expect(seen).toEqual(["Bearer test-token"]);
  } finally {
    tlsServer.closeAllConnections();
    await new Promise<void>((resolve) =>
      tlsServer.close(() => {
        resolve();
      }),
    );
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
