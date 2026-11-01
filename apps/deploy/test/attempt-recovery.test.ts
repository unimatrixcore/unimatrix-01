import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Fastify from "fastify";
import type { DeployAttemptRuntimeEvidence } from "@unimatrix/shared";

import { setupDeploymentAttempts } from "../src/attempts/lifecycle.js";
import { ATTEMPT_DEADLINE_MS } from "../src/attempts/model.js";
import { openDeploymentAttemptStore } from "../src/attempts/store.js";

const now = 1_000_000;
const input = {
  app: "deploy",
  actorUserId: "admin",
  requestId: "00000000-0000-4000-8000-000000000001",
};
const baseline = { containerId: "a".repeat(64), observedAt: now };
const replacement: DeployAttemptRuntimeEvidence = {
  app: "deploy",
  containerId: "b".repeat(64),
  observedAt: now + 1000,
  image: {
    repository: "ghcr.io/unimatrixcore/unimatrix-deploy",
    platform: "linux/amd64",
    digestKind: "manifest",
    digest: `sha256:${"c".repeat(64)}`,
  },
};

void test("opening a store cannot recover active queue claims; explicit startup recovery can", () => {
  const directory = mkdtempSync(join(tmpdir(), "attempt-recovery-"));
  const path = join(directory, "deploy.sqlite");
  let store = openDeploymentAttemptStore(path);
  try {
    const { attempt } = store.reserveManual(input, "api-service", baseline, now);
    store.report(
      { attemptId: attempt.id, stage: "queue", result: "started" },
      "api-service",
      now + 1,
    );
    store.close();
    store = openDeploymentAttemptStore(path);
    assert.equal(store.get("deploy", attempt.id, now + 2)?.queue, "started");
    store.observe([replacement], replacement.observedAt);
    assert.equal(store.get("deploy", attempt.id, replacement.observedAt)?.outcome, "incomplete");
    assert.throws(() => {
      store.recoverInterruptedQueues(-1);
    }, /Invalid deployment observation time/u);
    assert.equal(store.get("deploy", attempt.id, replacement.observedAt)?.queue, "started");

    store.recoverInterruptedQueues(replacement.observedAt);
    const recovered = store.get("deploy", attempt.id, replacement.observedAt)!;
    assert.equal(recovered.queue, "unknown");
    assert.equal(recovered.queueClaimedAt, now + 1);
    assert.equal(recovered.outcome, "incomplete");
    assert.equal(recovered.after, null);
    assert.equal(recovered.recreatedAt, null);
    assert.equal(
      recovered.failureReason,
      "Deployment queue has an unknown result. Resolve the pending operation before retrying.",
    );
    store.recoverInterruptedQueues(replacement.observedAt + 1);
    assert.deepEqual(store.get("deploy", attempt.id, replacement.observedAt + 1), recovered);
    assert.deepEqual(
      store.reserveManual(input, "api-service", baseline, replacement.observedAt + 1),
      { attempt: recovered, created: false },
    );
    assert.throws(
      () =>
        store.reserveManual(
          { ...input, requestId: "00000000-0000-4000-8000-000000000002" },
          "api-service",
          baseline,
          replacement.observedAt + 1,
        ),
      /conflicts/u,
    );
    store.observe([{ ...replacement, containerId: baseline.containerId }], replacement.observedAt);
    assert.equal(store.get("deploy", attempt.id, replacement.observedAt)?.outcome, "incomplete");
    store.observe([replacement], replacement.observedAt);
    const completed = store.findManual(input, "api-service", replacement.observedAt)!;
    assert.equal(completed.id, attempt.id);
    assert.equal(completed.queue, "unknown");
    assert.equal(completed.outcome, "recreated");
    assert.equal(completed.recreatedAt, replacement.observedAt);
    assert.equal(completed.correlation, "pending");
    assert.equal(completed.landedAt, null);
    assert.equal(completed.failureReason, null);
    assert.equal(
      store.reserveManual(input, "api-service", baseline, replacement.observedAt).created,
      false,
    );
    assert.equal(store.list("deploy", 100, replacement.observedAt).length, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("startup recovery changes only started queues and does not release expired uncertainty", () => {
  const store = openDeploymentAttemptStore(":memory:");
  try {
    const results = [null, "started", "acknowledged", "rejected", "unknown"] as const;
    for (const [index, queue] of results.entries()) {
      const { attempt } = store.reserveManual(
        {
          ...input,
          app: `app-${index}`,
          requestId: `00000000-0000-4000-8000-00000000000${index + 1}`,
        },
        "api-service",
        baseline,
        now,
      );
      if (queue !== null) {
        store.report(
          { attemptId: attempt.id, stage: "queue", result: "started" },
          "api-service",
          now + 1,
        );
        if (queue !== "started")
          store.report(
            { attemptId: attempt.id, stage: "queue", result: queue },
            "api-service",
            now + 2,
          );
      }
    }
    const ci = store.intent(
      {
        app: "ci",
        trigger: "ci",
        repository: "unimatrixcore/unimatrix-01",
        runId: "123",
        runAttempt: 1,
        image: { ...replacement.image, tag: "main", commit: "d".repeat(40) },
      },
      "ci-service",
      baseline,
      now,
    );
    store.report(
      { attemptId: ci.id, stage: "tag-write", result: "started" },
      "ci-service",
      now + 1,
    );
    const before = store.list(undefined, 100, now + 3);
    store.recoverInterruptedQueues(now + 4);
    const after = store.list(undefined, 100, now + 4);
    for (const record of before) {
      const recovered = after.find((entry) => entry.id === record.id)!;
      if (record.queue === "started") assert.equal(recovered.queue, "unknown");
      else assert.deepEqual(recovered, record);
    }
    const expired = store.reserveManual(
      { ...input, app: "late", requestId: "00000000-0000-4000-8000-000000000006" },
      "api-service",
      baseline,
      now,
    );
    store.report(
      { attemptId: expired.attempt.id, stage: "queue", result: "started" },
      "api-service",
      now + 1,
    );
    store.recoverInterruptedQueues(now + ATTEMPT_DEADLINE_MS);
    const late = store.get("late", expired.attempt.id, now + ATTEMPT_DEADLINE_MS)!;
    assert.equal(late.queue, "unknown");
    assert.equal(late.outcome, "timed-out");
    assert.throws(
      () =>
        store.reserveManual(
          { ...input, app: "late", requestId: "00000000-0000-4000-8000-000000000007" },
          "api-service",
          baseline,
          now + ATTEMPT_DEADLINE_MS,
        ),
      /conflicts/u,
    );
  } finally {
    store.close();
  }
});

void test("service startup recovers interrupted queues before the first runtime observation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "attempt-startup-recovery-"));
  const path = join(directory, "deploy.sqlite");
  const time = Date.now() - 1000;
  const first = openDeploymentAttemptStore(path);
  const { attempt } = first.reserveManual(
    input,
    "api-service",
    { ...baseline, observedAt: time },
    time,
  );
  first.report(
    { attemptId: attempt.id, stage: "queue", result: "started" },
    "api-service",
    time + 1,
  );
  first.close();
  const app = Fastify();
  let sampled = false;
  setupDeploymentAttempts(app, path, undefined, () => {
    assert.equal(app.deploymentAttempts.get("deploy", attempt.id, Date.now())?.queue, "unknown");
    sampled = true;
    return Promise.resolve([{ ...replacement, observedAt: Date.now() }]);
  });
  try {
    await app.ready();
    assert.equal(sampled, false);
    assert.equal(app.deploymentAttempts.get("deploy", attempt.id, Date.now())?.queue, "unknown");
    await app.listen({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sampled, true);
    assert.equal(
      app.deploymentAttempts.get("deploy", attempt.id, Date.now())?.outcome,
      "recreated",
    );
    assert.equal(app.deploymentAttempts.list("deploy", 100, Date.now()).length, 1);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
