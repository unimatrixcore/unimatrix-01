import assert from "node:assert/strict";
import test from "node:test";
import type { DeployAttemptRecord, DeployAttemptRuntimeEvidence } from "@unimatrix/shared";

import { buildApp } from "../src/app.js";
import { loadDeployRuntimeConfig } from "../src/config.js";
import { openServiceTokenStore } from "../src/service-tokens/store.js";

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

function fixture() {
  const tokens = openServiceTokenStore(":memory:");
  const read = tokens.issue({ name: "reader", capability: "read" }).token;
  const manage = tokens.issue({ name: "ci", capability: "manage" }).token;
  const other = tokens.issue({ name: "other", capability: "manage" }).token;
  let evidence: DeployAttemptRuntimeEvidence[] = [];
  const app = buildApp(
    loadDeployRuntimeConfig({
      NODE_ENV: "test",
      DEPLOY_DATABASE_PATH: ":memory:",
      DOKPLOY_BASE_URL: "http://unused",
      DOKPLOY_API_KEY: "unused",
    }),
    {
      serviceTokens: tokens,
      dokploy: {
        getContainers: () => assert.fail("attempt reporting must not call Dokploy"),
        getProjects: () => assert.fail("unused"),
        getCompose: () => assert.fail("unused"),
        getDokployVersion: () => assert.fail("unused"),
        updateComposeSettings: () => assert.fail("must not mutate"),
      },
      readRuntimeEvidence: () => Promise.resolve(evidence),
    },
  );
  return {
    app,
    read,
    manage,
    other,
    setEvidence: (value: DeployAttemptRuntimeEvidence[]) => {
      evidence = value;
    },
  };
}

void test("attempt routes authenticate writes, capture independent full baseline, and bound reads", async () => {
  const f = fixture();
  try {
    for (const token of [undefined, f.read]) {
      const response = await f.app.inject({
        method: "POST",
        url: "/deployment/attempts/intent",
        payload: intent,
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      });
      assert.equal(response.statusCode, token === undefined ? 401 : 403);
    }
    f.setEvidence([
      {
        app: "api",
        containerId: "b".repeat(64),
        observedAt: Date.now(),
        image: {
          repository: image.repository,
          platform: image.platform,
          digestKind: "manifest",
          digest: image.digest,
        },
      },
    ]);
    const response = await f.app.inject({
      method: "POST",
      url: "/deployment/attempts/intent",
      payload: intent,
      headers: { authorization: `Bearer ${f.manage}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    const record = response.json<DeployAttemptRecord>();
    assert.equal(record.baseline?.containerId, "b".repeat(64));
    assert.equal(record.outcome, "incomplete");
    assert.notEqual(record.reporterId, "ci");
    const headers = { authorization: `Bearer ${f.manage}` };
    for (const result of ["started", "acknowledged"]) {
      const r = await f.app.inject({
        method: "POST",
        url: "/deployment/attempts/report",
        headers,
        payload: { attemptId: record.id, stage: "tag-write", result },
      });
      assert.equal(r.statusCode, 200, r.body);
    }
    const conflict = await f.app.inject({
      method: "POST",
      url: "/deployment/attempts/report",
      headers: { authorization: `Bearer ${f.other}` },
      payload: { attemptId: record.id, stage: "queue", result: "started" },
    });
    assert.equal(conflict.statusCode, 409);
    const history = await f.app.inject({
      url: "/deployment/attempts?app=api&limit=1",
      headers: { authorization: `Bearer ${f.read}` },
    });
    assert.equal(history.statusCode, 200, history.body);
    assert.equal(history.headers["cache-control"], "no-store");
    assert.equal(history.json<{ attempts: DeployAttemptRecord[] }>().attempts.length, 1);
    assert.equal(
      (await f.app.inject({ url: "/deployment/attempts?limit=101", headers })).statusCode,
      400,
    );
    assert.equal(
      (await f.app.inject({ url: "/deployment/attempts?app=absent", headers })).statusCode,
      404,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/deployment/attempts/intent",
          headers,
          payload: { ...intent, image: { ...image, repository: "ghcr.io/foreign/api" } },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/deployment/attempts/intent",
          headers,
          payload: { ...intent, baseline: { containerId: "c".repeat(64), observedAt: Date.now() } },
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.app.close();
  }
});

void test("a missing or ambiguous bridge baseline cannot be invented by the caller", async () => {
  for (const mode of ["missing", "ambiguous"]) {
    const f = fixture();
    try {
      if (mode === "ambiguous")
        f.setEvidence(
          ["b", "c"].map((id) => ({
            app: "api",
            containerId: id.repeat(64),
            observedAt: Date.now(),
            image: {
              repository: image.repository,
              platform: image.platform,
              digestKind: "manifest" as const,
              digest: image.digest,
            },
          })),
        );
      const response = await f.app.inject({
        method: "POST",
        url: "/deployment/attempts/intent",
        headers: { authorization: `Bearer ${f.manage}` },
        payload: intent,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<DeployAttemptRecord>().baseline, null);
    } finally {
      await f.app.close();
    }
  }
});

void test("latest-per-app reads keep quiet services visible without fetching every history", async () => {
  const f = fixture();
  try {
    await f.app.ready();
    const now = Date.now() - 1000;
    const store = f.app.deploymentAttempts;
    const old = store.intent(
      intent,
      "reporter",
      { containerId: "b".repeat(64), observedAt: now },
      now,
    );
    store.report({ attemptId: old.id, stage: "tag-write", result: "started" }, "reporter", now + 1);
    store.report(
      { attemptId: old.id, stage: "tag-write", result: "rejected" },
      "reporter",
      now + 2,
    );
    const recent = store.intent(
      { ...intent, runId: "43" },
      "reporter",
      { containerId: "b".repeat(64), observedAt: now + 3 },
      now + 3,
    );
    const web = store.intent(
      {
        ...intent,
        app: "web",
        image: { ...image, repository: "ghcr.io/unimatrixcore/unimatrix-web" },
      },
      "reporter",
      { containerId: "c".repeat(64), observedAt: now },
      now,
    );
    const headers = { authorization: `Bearer ${f.read}` };
    const response = await f.app.inject({
      url: "/deployment/attempts?latestPerApp=true&limit=100",
      headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      response.json<{ attempts: DeployAttemptRecord[] }>().attempts.map((record) => record.id),
      [recent.id, web.id],
    );
    const selected = await f.app.inject({
      url: "/deployment/attempts?app=api&latestPerApp=true",
      headers,
    });
    assert.deepEqual(
      selected.json<{ attempts: DeployAttemptRecord[] }>().attempts.map((record) => record.id),
      [recent.id],
    );
    assert.equal(
      (await f.app.inject({ url: "/deployment/attempts?latestPerApp=false", headers })).statusCode,
      400,
    );
  } finally {
    await f.app.close();
  }
});
