import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { DeployAttemptRecord } from "@unimatrix/shared";
import { buildApp } from "../src/app.js";
import { loadDeployRuntimeConfig } from "../src/config.js";
import { openServiceTokenStore } from "../src/service-tokens/store.js";
import { DokployClientError } from "../src/dokploy/transport.js";
import { createDokployRedeployClient } from "../src/dokploy/redeploy-client.js";

function fixture() {
  const tokens = openServiceTokenStore(":memory:");
  const manage = tokens.issue({ name: "api", capability: "manage" }).token;
  const read = tokens.issue({ name: "reader", capability: "read" }).token;
  const calls: unknown[] = [];
  let matches = 1;
  let owner = "unimatrixcore";
  let sourceType = "github";
  let queueError: Error | undefined;
  let readError = false;
  let evidenceMode: "fresh" | "missing" | "stale" = "fresh";
  const app = buildApp(
    loadDeployRuntimeConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "error",
      DEPLOY_DATABASE_PATH: ":memory:",
      DOKPLOY_BASE_URL: "http://unused",
      DOKPLOY_API_KEY: "unused",
    }),
    {
      serviceTokens: tokens,
      dokploy: {
        getContainers: () => Promise.resolve([]),
        getDokployVersion: () => Promise.resolve("unused"),
        updateComposeSettings: () => assert.fail("must not rewrite config"),
        getProjects: () => {
          calls.push("projects");
          if (readError) return Promise.reject(new Error("private-upstream-value"));
          return Promise.resolve([
            {
              projectId: "p",
              name: "p",
              environments: [
                {
                  environmentId: "e",
                  name: "e",
                  compose: Array.from({ length: matches }, () => ({
                    composeId: "compose-api",
                    name: "api",
                    composeStatus: "done",
                  })),
                },
              ],
            },
          ]);
        },
        getCompose: () =>
          Promise.resolve({
            composeId: "compose-api",
            name: "api",
            environmentId: "e",
            composePath: "./infra/docker/api-compose.yaml",
            sourceType,
            owner,
            repository: "unimatrix-01",
            branch: "main",
            autoDeploy: false,
            env: [],
          }),
      },
      readRuntimeEvidence: () =>
        Promise.resolve(
          evidenceMode === "missing"
            ? []
            : [
                {
                  app: "api",
                  containerId: "a".repeat(64),
                  observedAt: Date.now() - (evidenceMode === "stale" ? 30_001 : 0),
                  image: {
                    repository: "ghcr.io/unimatrixcore/unimatrix-api",
                    platform: "linux/amd64",
                    digestKind: "manifest",
                    digest: `sha256:${"b".repeat(64)}`,
                  },
                },
              ],
        ),
      redeployment: {
        queueRedeploy: (composeId, attemptId) => {
          calls.push(["queue", composeId, attemptId]);
          if (queueError) return Promise.reject(queueError);
          return Promise.resolve();
        },
      },
    },
  );
  const payload = { app: "api", requestId: randomUUID(), actorUserId: "user_verified" };
  const send = (body: unknown = payload, token: string | undefined = manage) =>
    app.inject({
      method: "POST",
      url: "/deployment/redeploy",
      payload: body as object,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
  return {
    app,
    calls,
    payload,
    send,
    read,
    setMatches: (value: number) => {
      matches = value;
    },
    setOwner: (value: string) => {
      owner = value;
    },
    setSource: (value: string) => {
      sourceType = value;
    },
    setQueueError: (value: Error) => {
      queueError = value;
    },
    failReads: () => {
      readError = true;
    },
    setEvidenceMode: (value: "fresh" | "missing" | "stale") => {
      evidenceMode = value;
    },
  };
}

void test("manual queueing records attribution, is idempotent, rejects overlap and never writes config", async () => {
  const f = fixture();
  try {
    const first = await f.send();
    assert.equal(first.statusCode, 200, first.body);
    const record = first.json<DeployAttemptRecord>();
    assert.equal(record.image, null);
    assert.equal(record.actorUserId, "user_verified");
    assert.equal(record.tagWrite, null);
    assert.equal(record.queue, "acknowledged");
    assert.equal(record.outcome, "queued");
    f.failReads();
    const retry = await f.send();
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json<DeployAttemptRecord>().id, record.id);
    assert.equal(f.calls.filter(Array.isArray).length, 1);
  } finally {
    await f.app.close();
  }
});

void test("an unresolved queued request blocks a different manual request", async () => {
  const f = fixture();
  try {
    assert.equal((await f.send()).statusCode, 200);
    assert.equal((await f.send({ ...f.payload, requestId: randomUUID() })).statusCode, 409);
    assert.equal(f.calls.filter(Array.isArray).length, 1);
  } finally {
    await f.app.close();
  }
});

void test("auth, selectors, self and unknown app refuse before Dokploy calls", async () => {
  const f = fixture();
  try {
    assert.equal(
      (await f.app.inject({ method: "POST", url: "/deployment/redeploy", payload: f.payload }))
        .statusCode,
      401,
    );
    assert.equal((await f.send(f.payload, f.read)).statusCode, 403);
    assert.equal((await f.send({ ...f.payload, composeId: "arbitrary" })).statusCode, 400);
    assert.equal((await f.send({ ...f.payload, app: "deploy" })).statusCode, 409);
    assert.equal((await f.send({ ...f.payload, app: "absent" })).statusCode, 404);
    assert.deepEqual(f.calls, []);
  } finally {
    await f.app.close();
  }
});

void test("missing, ambiguous, foreign and unsupported-source matches never queue", async () => {
  for (const mode of ["missing", "ambiguous", "foreign", "source", "failed-read"]) {
    const f = fixture();
    try {
      if (mode === "missing") f.setMatches(0);
      if (mode === "ambiguous") f.setMatches(2);
      if (mode === "foreign") f.setOwner("foreign");
      if (mode === "source") f.setSource("git");
      if (mode === "failed-read") f.failReads();
      const response = await f.send();
      assert.equal(response.statusCode, mode === "failed-read" ? 503 : 409, response.body);
      assert.doesNotMatch(response.body, /private-upstream-value/);
      assert.equal(f.calls.filter(Array.isArray).length, 0);
    } finally {
      await f.app.close();
    }
  }
});

void test("queue rejection and uncertain transport results are durably recorded without retries", async () => {
  for (const error of [
    new DokployClientError("private", 400),
    new DokployClientError("private", 408),
    new DokployClientError("private", 429),
    new DokployClientError("private", 500),
    new Error("private"),
  ]) {
    const f = fixture();
    try {
      f.setQueueError(error);
      const response = await f.send();
      assert.equal(response.statusCode, 200, response.body);
      const record = response.json<DeployAttemptRecord>();
      assert.equal(
        record.queue,
        error instanceof DokployClientError && error.status === 400 ? "rejected" : "unknown",
      );
      assert.doesNotMatch(response.body, /private/);
      await f.send();
      assert.equal(f.calls.filter(Array.isArray).length, 1);
      if (!(error instanceof DokployClientError) || error.status !== 400) {
        assert.equal((await f.send({ ...f.payload, requestId: randomUUID() })).statusCode, 409);
        assert.equal(f.calls.filter(Array.isArray).length, 1);
      }
    } finally {
      await f.app.close();
    }
  }
});

void test("manual redeploy refuses unavailable or stale baselines before reserving or queueing", async () => {
  for (const mode of ["missing", "stale"] as const) {
    const f = fixture();
    try {
      f.setEvidenceMode(mode);
      assert.equal((await f.send()).statusCode, 503);
      assert.equal(f.calls.filter(Array.isArray).length, 0);
      assert.deepEqual(f.app.deploymentAttempts.list("api", 100, Date.now()), []);
      f.setEvidenceMode("fresh");
      const recovered = await f.send();
      assert.equal(recovered.statusCode, 200, recovered.body);
    } finally {
      await f.app.close();
    }
  }
});

void test("redeploy capability sends only compose ID and attempt marker and discards success body", async () => {
  let seen = false;
  const client = createDokployRedeployClient({
    baseUrl: "http://dokploy",
    apiKey: "test-key",
    fetch: (url, options) => {
      assert.ok(url instanceof URL);
      assert.equal(url.href, "http://dokploy/api/compose.deploy");
      assert.equal(options?.method, "POST");
      assert.deepEqual(JSON.parse(options?.body as string), {
        composeId: "compose-api",
        title: "unimatrix-attempt:attempt",
      });
      seen = true;
      return Promise.resolve({
        ok: true,
        json: () => assert.fail("must not read success body"),
      } as unknown as Response);
    },
  });
  await client.queueRedeploy("compose-api", "attempt");
  assert.equal(seen, true);
});
