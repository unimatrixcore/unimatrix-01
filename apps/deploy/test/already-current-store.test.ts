import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DeployAttemptIntent, DeployRuntimeEvidence } from "@unimatrix/shared";

import { openDeploymentAttemptStore } from "../src/attempts/store.js";
import { ATTEMPT_DEADLINE_MS } from "../src/attempts/model.js";

const now = 1_000_000;
const intent: DeployAttemptIntent = {
  repository: "unimatrixcore/unimatrix-01",
  runId: "123",
  runAttempt: 1,
  app: "api",
  trigger: "ci",
  image: {
    repository: "ghcr.io/unimatrixcore/unimatrix-api",
    tag: "b".repeat(40),
    commit: "b".repeat(40),
    platform: "linux/amd64",
    digestKind: "manifest",
    digest: `sha256:${"c".repeat(64)}`,
  },
};
const evidence: DeployRuntimeEvidence = {
  app: "api",
  containerId: "a".repeat(64),
  observedAt: now - 1000,
  image: {
    repository: intent.image.repository,
    platform: intent.image.platform,
    digestKind: intent.image.digestKind,
    digest: intent.image.digest,
  },
  metadata: {
    name: "api",
    startedAt: now - 2000,
    health: "healthy",
    imageTag: intent.image.tag,
    commit: intent.image.commit,
    commitSubject: null,
  },
};
const baseline = { containerId: evidence.containerId, observedAt: evidence.observedAt };

void test("already-current resolution persists and releases the app without claiming recreation", () => {
  const directory = mkdtempSync(join(tmpdir(), "already-current-store-"));
  const path = join(directory, "attempts.sqlite");
  let store = openDeploymentAttemptStore(path);
  try {
    const pending = store.intent(intent, "ci", baseline, now);
    const resolved = store.resolveAlreadyCurrent("api", pending.id, "ci", now + 1, evidence);
    assert.equal(resolved.outcome, "already-current");
    assert.equal(resolved.completedAt, now + 1);
    assert.equal(resolved.tagWrite, null);
    assert.equal(resolved.queue, null);
    assert.equal(resolved.queueClaimedAt, null);
    assert.equal(resolved.correlation, "verified");
    assert.equal(resolved.landedAt, null);
    assert.equal(resolved.lateLandedAt, null);
    assert.deepEqual(resolved.baseline, baseline);
    assert.deepEqual(resolved.after, {
      ...baseline,
      image: evidence.image,
    });
    store.close();
    store = openDeploymentAttemptStore(path);
    assert.deepEqual(store.get("api", pending.id, now + 2), resolved);
    assert.deepEqual(
      store.resolveAlreadyCurrent("api", pending.id, "ci", now + ATTEMPT_DEADLINE_MS + 1, evidence),
      resolved,
    );
    const next = store.intent({ ...intent, runId: "124" }, "ci", baseline, now + 3);
    assert.notEqual(next.id, resolved.id);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("resolution and a mutation claim exclude each other across store connections", () => {
  const directory = mkdtempSync(join(tmpdir(), "already-current-race-"));
  const path = join(directory, "attempts.sqlite");
  const first = openDeploymentAttemptStore(path);
  const second = openDeploymentAttemptStore(path);
  try {
    const resolvedFirst = first.intent(intent, "ci", baseline, now);
    first.resolveAlreadyCurrent("api", resolvedFirst.id, "ci", now + 1, evidence);
    const claim = second.claimExecution("api", resolvedFirst.id, "ci", now + 2, baseline);
    assert.equal(claim.claimed, false);
    assert.equal(claim.attempt.outcome, "already-current");
    for (const stage of ["tag-write", "queue"] as const) {
      assert.throws(() =>
        second.report({ attemptId: resolvedFirst.id, stage, result: "started" }, "ci", now + 3),
      );
    }
    const claimedFirst = first.intent({ ...intent, runId: "124" }, "ci", baseline, now + 4);
    assert.equal(
      first.claimExecution("api", claimedFirst.id, "ci", now + 5, baseline).claimed,
      true,
    );
    assert.throws(() =>
      second.resolveAlreadyCurrent("api", claimedFirst.id, "ci", now + 6, evidence),
    );
    assert.equal(first.get("api", claimedFirst.id, now + 7)?.tagWrite, "started");
  } finally {
    second.close();
    first.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("only a fresh exact CI identity can resolve an unclaimed intent", () => {
  const changed: DeployRuntimeEvidence[] = [
    { ...evidence, app: "web" },
    { ...evidence, observedAt: now + 2 },
    { ...evidence, observedAt: now - 30_000 },
    { ...evidence, image: { ...evidence.image, digest: `sha256:${"d".repeat(64)}` } },
    { ...evidence, image: { ...evidence.image, repository: "ghcr.io/foreign/api" } },
    { ...evidence, image: { ...evidence.image, platform: "linux/arm64" } },
    { ...evidence, metadata: { ...evidence.metadata!, commit: "d".repeat(40) } },
    { ...evidence, metadata: { ...evidence.metadata!, commit: null } },
    {
      app: evidence.app,
      containerId: evidence.containerId,
      observedAt: evidence.observedAt,
      image: evidence.image,
    },
  ];
  for (const observation of changed) {
    const store = openDeploymentAttemptStore(":memory:");
    try {
      const pending = store.intent(intent, "ci", baseline, now);
      assert.throws(() =>
        store.resolveAlreadyCurrent("api", pending.id, "ci", now + 1, observation),
      );
      assert.equal(store.get("api", pending.id, now + 1)?.outcome, "incomplete");
    } finally {
      store.close();
    }
  }
  const store = openDeploymentAttemptStore(":memory:");
  try {
    const pending = store.intent(intent, "ci", baseline, now);
    assert.throws(() => store.resolveAlreadyCurrent("web", pending.id, "ci", now + 1, evidence));
    assert.throws(() =>
      store.resolveAlreadyCurrent("api", pending.id, "foreign", now + 1, evidence),
    );
    assert.throws(() => store.resolveAlreadyCurrent("api", "missing", "ci", now + 1, evidence));
    assert.throws(() =>
      store.resolveAlreadyCurrent("api", pending.id, "ci", now + ATTEMPT_DEADLINE_MS, {
        ...evidence,
        observedAt: now + ATTEMPT_DEADLINE_MS,
      }),
    );
  } finally {
    store.close();
  }
});

void test("acknowledged tag correction can resolve without queueing and remains stable under observation", () => {
  const store = openDeploymentAttemptStore(":memory:");
  try {
    const pending = store.intent(intent, "ci", baseline, now);
    store.claimExecution("api", pending.id, "ci", now + 1, baseline);
    store.report(
      { attemptId: pending.id, stage: "tag-write", result: "acknowledged" },
      "ci",
      now + 2,
    );
    const resolved = store.resolveAlreadyCurrent("api", pending.id, "ci", now + 3, evidence);
    assert.equal(resolved.tagWrite, "acknowledged");
    assert.equal(resolved.queue, null);
    store.observe([{ ...evidence, containerId: "d".repeat(64), observedAt: now + 4 }], now + 4);
    assert.deepEqual(store.get("api", pending.id, now + 5), resolved);
    assert.throws(() =>
      store.report(
        { attemptId: pending.id, stage: "tag-write", result: "acknowledged" },
        "ci",
        now + 5,
      ),
    );
  } finally {
    store.close();
  }
});

void test("manual attempts and queued or rejected writes cannot resolve as already current", () => {
  const manual = openDeploymentAttemptStore(":memory:");
  try {
    const reservation = manual.reserveManual(
      { app: "api", requestId: "12345678-1234-4234-8234-123456789abc", actorUserId: "owner" },
      "ci",
      baseline,
      now,
    );
    assert.throws(() =>
      manual.resolveAlreadyCurrent("api", reservation.attempt.id, "ci", now + 1, evidence),
    );
  } finally {
    manual.close();
  }
  for (const result of ["rejected", "unknown", "queued"] as const) {
    const store = openDeploymentAttemptStore(":memory:");
    try {
      const pending = store.intent(intent, "ci", baseline, now);
      store.claimExecution("api", pending.id, "ci", now + 1, baseline);
      store.report(
        {
          attemptId: pending.id,
          stage: "tag-write",
          result: result === "queued" ? "acknowledged" : result,
        },
        "ci",
        now + 2,
      );
      if (result === "queued")
        store.report({ attemptId: pending.id, stage: "queue", result: "started" }, "ci", now + 3);
      assert.throws(() => store.resolveAlreadyCurrent("api", pending.id, "ci", now + 4, evidence));
    } finally {
      store.close();
    }
  }
});
