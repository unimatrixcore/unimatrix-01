import assert from "node:assert/strict";
import test from "node:test";

import type { DeployBaselinesResponse, DeployRuntimeEvidence } from "@unimatrix/shared";

import { buildApp } from "../src/app.js";
import { openDeploymentAttemptStore } from "../src/attempts/store.js";
import { loadDeployRuntimeConfig } from "../src/config.js";
import { selectDeploymentBaseline } from "../src/modules/deployment/baselines.js";
import { DEPLOY_DESIRED_STATE } from "../src/reconcile/desired-state.gen.js";
import { openServiceTokenStore } from "../src/service-tokens/store.js";

const NOW = 1_800_000_000_000;
const repository = "ghcr.io/unimatrixcore/unimatrix-api";
function evidence(observedAt = NOW): DeployRuntimeEvidence {
  return {
    app: "api",
    containerId: "a".repeat(64),
    observedAt,
    image: {
      repository,
      platform: "linux/amd64",
      digestKind: "manifest",
      digest: `sha256:${"b".repeat(64)}`,
    },
    metadata: {
      name: "api",
      startedAt: null,
      health: "healthy",
      imageTag: "main",
      commit: "c".repeat(40),
      commitSubject: "public subject",
    },
  };
}

void test("baseline requires unique fresh declared amd64 provenance and no unresolved work", () => {
  const sample = evidence();
  const selected = selectDeploymentBaseline("api", repository, [sample], false, NOW);
  assert.deepEqual(selected, {
    commit: sample.metadata!.commit,
    containerId: sample.containerId,
    observedAt: NOW,
    image: sample.image,
  });
  assert.ok(selectDeploymentBaseline("api", repository, [evidence(NOW - 29_999)], false, NOW));
  for (const samples of [
    [],
    [sample, sample],
    [evidence(NOW - 30_000)],
    [evidence(NOW + 1)],
    [{ ...sample, app: "web" }],
    [{ ...sample, image: { ...sample.image, repository: "foreign/image" } }],
    [{ ...sample, image: { ...sample.image, platform: "linux/arm64" } }],
    [{ ...sample, metadata: undefined }],
    [{ ...sample, metadata: { ...sample.metadata!, commit: null } }],
    [{ ...sample, containerId: "short" }],
  ]) {
    assert.equal(selectDeploymentBaseline("api", repository, samples, false, NOW), null);
  }
  assert.equal(selectDeploymentBaseline("api", repository, [sample], true, NOW), null);
});

function fixture() {
  const tokens = openServiceTokenStore(":memory:");
  const read = tokens.issue({ name: "read", capability: "read" }).token;
  const manage = tokens.issue({ name: "manage", capability: "manage" }).token;
  const revoked = tokens.issue({ name: "revoked", capability: "read" }).token;
  tokens.revoke("revoked");
  const attempts = openDeploymentAttemptStore(":memory:");
  let samples = [evidence(Date.now())];
  let readError = false;
  let reads = 0;
  const logs: string[] = [];
  const app = buildApp(
    loadDeployRuntimeConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      DEPLOY_DATABASE_PATH: ":memory:",
      DOKPLOY_BASE_URL: "http://unused",
      DOKPLOY_API_KEY: "unused",
    }),
    {
      serviceTokens: tokens,
      deploymentAttempts: attempts,
      readRuntimeEvidence: () => {
        reads++;
        if (readError) return Promise.reject(new Error("private-baseline-canary"));
        return Promise.resolve(samples);
      },
      dokploy: {
        getContainers: () => assert.fail("must not read Dokploy"),
        getDokployVersion: () => assert.fail("must not read Dokploy"),
        getProjects: () => assert.fail("must not read Dokploy"),
        getCompose: () => assert.fail("must not read Dokploy"),
        updateComposeSettings: () => assert.fail("must not mutate Dokploy"),
      },
      loggerStream: { write: (chunk) => logs.push(chunk) },
    },
  );
  return {
    app,
    attempts,
    read,
    manage,
    revoked,
    logs,
    get reads() {
      return reads;
    },
    set samples(value: DeployRuntimeEvidence[]) {
      samples = value;
    },
    set readError(value: boolean) {
      readError = value;
    },
  };
}

void test("baselines require credentials, allow read/manage and reject extra query keys", async () => {
  const f = fixture();
  try {
    for (const token of [undefined, "invalid", f.revoked]) {
      const response = await f.app.inject({
        url: "/deployment/baselines",
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      });
      assert.equal(response.statusCode, 401);
    }
    assert.equal(f.reads, 0);
    for (const token of [f.read, f.manage]) {
      const response = await f.app.inject({
        url: "/deployment/baselines",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.match(String(response.headers["cache-control"]), /no-store/u);
      const body = response.json<DeployBaselinesResponse>();
      assert.deepEqual(
        body.apps.map(({ app }) => app),
        DEPLOY_DESIRED_STATE.map(({ appDir }) => appDir),
      );
      assert.equal(body.apps.find(({ app }) => app === "api")!.baseline!.commit, "c".repeat(40));
      assert.equal(body.apps.find(({ app }) => app === "web")!.baseline, null);
    }
    const response = await f.app.inject({
      url: "/deployment/baselines?app=api",
      headers: { authorization: `Bearer ${f.read}` },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await f.app.close();
  }
});

void test("current rollback image determines the baseline rather than an earlier release", async () => {
  const f = fixture();
  try {
    const rolledBack = evidence(Date.now());
    rolledBack.metadata!.commit = "d".repeat(40);
    rolledBack.image.digest = `sha256:${"e".repeat(64)}`;
    f.samples = [rolledBack];
    const response = await f.app.inject({
      url: "/deployment/baselines",
      headers: { authorization: `Bearer ${f.read}` },
    });
    const baseline = response
      .json<DeployBaselinesResponse>()
      .apps.find(({ app }) => app === "api")!.baseline!;
    assert.equal(baseline.commit, "d".repeat(40));
    assert.equal(baseline.image.digest, `sha256:${"e".repeat(64)}`);
  } finally {
    await f.app.close();
  }
});

void test("complete retained history blocks baselines even outside the newest history page", async () => {
  const f = fixture();
  try {
    const now = Date.now();
    const intent = (app: string, runId: string) => ({
      repository: "unimatrixcore/unimatrix-01",
      runId,
      runAttempt: 1,
      app,
      trigger: "ci" as const,
      image: {
        ...evidence().image,
        repository: `ghcr.io/unimatrixcore/unimatrix-${app}`,
        tag: "f".repeat(40),
        commit: "f".repeat(40),
      },
    });
    f.attempts.intent(intent("api", "1"), "ci", null, now);
    for (let i = 2; i <= 102; i++) {
      const attempt = f.attempts.intent(intent("web", String(i)), "ci", null, now + i);
      f.attempts.report(
        { attemptId: attempt.id, stage: "tag-write", result: "started" },
        "ci",
        now + i,
      );
      f.attempts.report(
        { attemptId: attempt.id, stage: "tag-write", result: "rejected" },
        "ci",
        now + i,
      );
    }
    assert.equal(
      f.attempts.list(undefined, 100, now + 103).some(({ app }) => app === "api"),
      false,
    );
    assert.equal(f.attempts.hasUnresolvedWork("api", now + 103), true);
    assert.equal(f.attempts.hasUnresolvedWork("web", now + 103), false);
    const response = await f.app.inject({
      url: "/deployment/baselines",
      headers: { authorization: `Bearer ${f.read}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(
      response.json<DeployBaselinesResponse>().apps.find(({ app }) => app === "api")!.baseline,
      null,
    );
  } finally {
    await f.app.close();
  }
});

void test("baseline read failures return sanitized errors", async () => {
  const f = fixture();
  try {
    f.readError = true;
    const response = await f.app.inject({
      url: "/deployment/baselines",
      headers: { authorization: `Bearer ${f.read}` },
    });
    assert.equal(response.statusCode, 503);
    assert.doesNotMatch(response.body + f.logs.join(""), /private-baseline-canary/u);
  } finally {
    await f.app.close();
  }
});
