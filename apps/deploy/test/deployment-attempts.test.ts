import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";

import type { DeployAttemptIntent, DeployRuntimeEvidence } from "@unimatrix/shared";

import { openDeploymentAttemptStore as openRawStore } from "../src/attempts/store.js";
import {
  ATTEMPT_DEADLINE_MS,
  ATTEMPT_RETENTION_MS,
  MAX_ATTEMPT_RECORDS,
} from "../src/attempts/model.js";

function openDeploymentAttemptStore(path: string) {
  const store = openRawStore(path);
  const report = store.report.bind(store);
  return {
    ...store,
    report(input: Parameters<typeof report>[0], reporter: string, time: number) {
      const record = store.list(undefined, 100, time).find((entry) => entry.id === input.attemptId);
      const stageValue = input.stage === "tag-write" ? record?.tagWrite : record?.queue;
      if (stageValue === null) report({ ...input, result: "started" }, reporter, time);
      return report(input, reporter, time);
    },
  };
}
const now = 1_000_000;
const before = { containerId: "a".repeat(64), observedAt: now };
const intent: DeployAttemptIntent = {
  repository: "unimatrixcore/unimatrix-01",
  runId: "123",
  runAttempt: 1,
  app: "api",
  trigger: "ci",
  image: {
    repository: "ghcr.io/unimatrixcore/unimatrix-api",
    tag: "main",
    commit: "b".repeat(40),
    platform: "linux/amd64",
    digestKind: "manifest",
    digest: `sha256:${"c".repeat(64)}`,
  },
};
const evidence: DeployRuntimeEvidence = {
  app: "api",
  containerId: "d".repeat(64),
  observedAt: now + 1000,
  image: {
    repository: intent.image.repository,
    platform: intent.image.platform,
    digestKind: "manifest",
    digest: intent.image.digest,
  },
};

void test("durable intent is idempotent across restarts and conflicts cannot rewrite requested image or reporter", () => {
  const directory = mkdtempSync(join(tmpdir(), "attempt-store-"));
  try {
    const path = join(directory, "db.sqlite");
    const first = openDeploymentAttemptStore(path);
    const record = first.intent(intent, "reporter", before, now);
    first.close();
    const second = openDeploymentAttemptStore(path);
    assert.deepEqual(second.intent(intent, "reporter", null, now + 1), record);
    assert.throws(() => second.intent(intent, "other", before, now + 1), /conflicts/u);
    assert.throws(
      () =>
        second.intent(
          { ...intent, image: { ...intent.image, digest: `sha256:${"e".repeat(64)}` } },
          "reporter",
          before,
          now,
        ),
      /conflicts/u,
    );
    assert.throws(
      () => second.intent({ ...intent, trigger: "rollback" }, "reporter", before, now),
      /conflicts/u,
    );
    const rerun = second.intent({ ...intent, runAttempt: 2 }, "reporter", before, now + 10);
    assert.notEqual(rerun.id, record.id);
    assert.equal(rerun.correlation, "ambiguous");
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("reports record queue acknowledgement independently from verified landing", () => {
  const store = openDeploymentAttemptStore(":memory:");
  try {
    const record = store.intent(intent, "reporter", before, now);
    assert.throws(
      () =>
        store.report(
          { attemptId: record.id, stage: "queue", result: "acknowledged" },
          "reporter",
          now,
        ),
      /conflicts/u,
    );
    assert.throws(
      () =>
        store.report(
          { attemptId: record.id, stage: "tag-write", result: "acknowledged" },
          "other",
          now,
        ),
      /conflicts/u,
    );
    assert.throws(
      () =>
        store.report(
          {
            attemptId: "00000000-0000-4000-8000-000000000000",
            stage: "tag-write",
            result: "acknowledged",
          },
          "reporter",
          now,
        ),
      /not found/u,
    );
    const tag = { attemptId: record.id, stage: "tag-write", result: "acknowledged" } as const;
    assert.equal(store.report(tag, "reporter", now).outcome, "incomplete");
    assert.deepEqual(store.report(tag, "reporter", now), store.report(tag, "reporter", now));
    assert.throws(
      () => store.report({ ...tag, result: "rejected" }, "reporter", now),
      /conflicts/u,
    );
    const queue = { attemptId: record.id, stage: "queue", result: "acknowledged" } as const;
    assert.equal(store.report(queue, "reporter", now).outcome, "queued");
    store.observe([evidence], now + 1000);
    const landed = store.list("api", 10, now + 1000)[0]!;
    assert.equal(landed.outcome, "landed");
    assert.equal(landed.landedAt, evidence.observedAt);
    assert.deepEqual(landed.after, {
      containerId: evidence.containerId,
      observedAt: evidence.observedAt,
      image: evidence.image,
    });
    assert.equal(store.report(queue, "reporter", now + 2000).outcome, "landed");
    store.observe([{ ...evidence, observedAt: now + 3000 }], now + 3000);
    assert.equal(store.list(undefined, 10, now + 3000)[0]!.landedAt, evidence.observedAt);
  } finally {
    store.close();
  }
});

void test("deadline expires missing callbacks, late evidence preserves timeout, and recovery uses durable baseline", () => {
  const directory = mkdtempSync(join(tmpdir(), "attempt-recovery-"));
  try {
    const path = join(directory, "db.sqlite");
    let store = openDeploymentAttemptStore(path);
    const record = store.intent(intent, "reporter", before, now);
    store.report(
      { attemptId: record.id, stage: "tag-write", result: "acknowledged" },
      "reporter",
      now,
    );
    store.report({ attemptId: record.id, stage: "queue", result: "unknown" }, "reporter", now);
    store.close();
    store = openDeploymentAttemptStore(path);
    const late = now + ATTEMPT_DEADLINE_MS + 1;
    assert.equal(store.list(undefined, 100, late)[0]!.outcome, "timed-out");
    store.observe([{ ...evidence, observedAt: late }], late);
    const observed = store.list(undefined, 100, late)[0]!;
    assert.equal(observed.outcome, "timed-out");
    assert.equal(observed.landedAt, null);
    assert.equal(observed.lateLandedAt, late);
    assert.equal(observed.correlation, "verified");
    store.observe([{ ...evidence, observedAt: late + 1 }], late + 1);
    assert.equal(store.list(undefined, 100, late + 1)[0]!.lateLandedAt, late);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const store = openDeploymentAttemptStore(":memory:");
  try {
    store.intent(intent, "reporter", before, now);
    assert.equal(store.list(undefined, 100, now + ATTEMPT_DEADLINE_MS)[0]!.outcome, "timed-out");
  } finally {
    store.close();
  }
});

void test("definite rejection fails; unknown tag result does not queue or fail; late callbacks cannot erase timeout", () => {
  for (const stage of ["tag-write", "queue"] as const) {
    const store = openDeploymentAttemptStore(":memory:");
    try {
      const record = store.intent(intent, "reporter", before, now);
      if (stage === "queue")
        store.report(
          { attemptId: record.id, stage: "tag-write", result: "acknowledged" },
          "reporter",
          now,
        );
      assert.equal(
        store.report({ attemptId: record.id, stage, result: "rejected" }, "reporter", now).outcome,
        "failed",
      );
      store.observe([evidence], now + 1000);
      assert.equal(store.list(undefined, 100, now + 1000)[0]!.outcome, "failed");
    } finally {
      store.close();
    }
  }
  const store = openDeploymentAttemptStore(":memory:");
  try {
    const record = store.intent(intent, "reporter", before, now);
    assert.equal(
      store.report({ attemptId: record.id, stage: "tag-write", result: "unknown" }, "reporter", now)
        .outcome,
      "incomplete",
    );
    store.observe([evidence], now + 1000);
    assert.equal(store.list(undefined, 100, now + 1000)[0]!.outcome, "incomplete");
    assert.equal(
      store.report(
        { attemptId: record.id, stage: "tag-write", result: "unknown" },
        "reporter",
        now + ATTEMPT_DEADLINE_MS,
      ).outcome,
      "timed-out",
    );
  } finally {
    store.close();
  }
});

void test("a tag, changed ID, wrong digest, absent baseline, or missing queue result never establishes landed", () => {
  const cases: {
    baseline: typeof before | null;
    sample: DeployRuntimeEvidence;
    queue?: boolean;
  }[] = [
    { baseline: null, sample: evidence },
    { baseline: before, sample: { ...evidence, containerId: before.containerId } },
    {
      baseline: before,
      sample: { ...evidence, image: { ...evidence.image, digest: `sha256:${"e".repeat(64)}` } },
    },
    {
      baseline: before,
      sample: { ...evidence, image: { ...evidence.image, platform: "linux/arm64" } },
    },
    {
      baseline: before,
      sample: { ...evidence, image: { ...evidence.image, repository: "ghcr.io/other/image" } },
    },
    { baseline: before, sample: { ...evidence, app: "web" } },
    { baseline: before, sample: { ...evidence, observedAt: now - 1 } },
    { baseline: before, sample: evidence, queue: false },
  ];
  for (const example of cases) {
    const store = openDeploymentAttemptStore(":memory:");
    try {
      const record = store.intent(intent, "reporter", example.baseline, now);
      store.report(
        { attemptId: record.id, stage: "tag-write", result: "acknowledged" },
        "reporter",
        now,
      );
      if (example.queue !== false)
        store.report(
          { attemptId: record.id, stage: "queue", result: "acknowledged" },
          "reporter",
          now,
        );
      store.observe([example.sample], now + 1000);
      const after = store.list(undefined, 100, now + 1000)[0]!;
      assert.notEqual(after.outcome, "landed");
      assert.equal(after.after, null);
    } finally {
      store.close();
    }
  }
});

void test("overlapping and expired requests retain ambiguous correlation across restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "attempt-overlap-"));
  try {
    const path = join(directory, "db.sqlite");
    let store = openDeploymentAttemptStore(path);
    const first = store.intent(intent, "reporter", before, now);
    store.report(
      { attemptId: first.id, stage: "tag-write", result: "acknowledged" },
      "reporter",
      now,
    );
    store.report({ attemptId: first.id, stage: "queue", result: "acknowledged" }, "reporter", now);
    const secondTime = now + ATTEMPT_DEADLINE_MS + 1;
    const second = store.intent({ ...intent, runId: "124" }, "reporter", before, secondTime);
    store.report(
      { attemptId: second.id, stage: "tag-write", result: "acknowledged" },
      "reporter",
      secondTime,
    );
    store.report(
      { attemptId: second.id, stage: "queue", result: "acknowledged" },
      "reporter",
      secondTime,
    );
    store.close();
    store = openDeploymentAttemptStore(path);
    store.observe([{ ...evidence, observedAt: secondTime + 1 }], secondTime + 1);
    assert.deepEqual(
      store.list("api", 100, secondTime + 1).map((record) => record.correlation),
      ["ambiguous", "ambiguous"],
    );
    assert.deepEqual(
      store.list("api", 100, secondTime + 1).map((record) => record.outcome),
      ["queued", "timed-out"],
    );
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("failed and previously landed attempts do not make later requests ambiguous", () => {
  const store = openDeploymentAttemptStore(":memory:");
  try {
    const first = store.intent(intent, "reporter", before, now);
    store.report({ attemptId: first.id, stage: "tag-write", result: "rejected" }, "reporter", now);
    const next = store.intent({ ...intent, runId: "124" }, "reporter", before, now + 1);
    assert.equal(next.correlation, "pending");
    store.report(
      { attemptId: next.id, stage: "tag-write", result: "acknowledged" },
      "reporter",
      now + 1,
    );
    store.report(
      { attemptId: next.id, stage: "queue", result: "acknowledged" },
      "reporter",
      now + 1,
    );
    store.observe([evidence], now + 1000);
    assert.equal(
      store.intent(
        { ...intent, runId: "125" },
        "reporter",
        { containerId: evidence.containerId, observedAt: now + 1000 },
        now + 1001,
      ).correlation,
      "pending",
    );
  } finally {
    store.close();
  }
});

void test("history is bounded, oldest records expire after their evidence retention window, invalid time fails closed", () => {
  const store = openDeploymentAttemptStore(":memory:");
  try {
    store.intent(intent, "reporter", before, now);
    store.intent({ ...intent, app: "web" }, "reporter", before, now + 1);
    assert.equal(store.list(undefined, 1, now + 1).length, 1);
    assert.equal(store.list("api", 100, now + 1).length, 1);
    assert.throws(() => store.list(undefined, 101, now), /limit/u);
    assert.throws(() => store.list(undefined, 0, now), /limit/u);
    assert.throws(() => store.list(undefined, 1, -1), /time/u);
    assert.throws(() => store.list(undefined, 1, Number.MAX_SAFE_INTEGER), /time/u);
    assert.throws(() => store.intent(intent, "", before, now), /conflicts/u);
    assert.throws(() => store.intent(intent, "r".repeat(129), before, now), /conflicts/u);
    assert.throws(
      () => store.intent(intent, "reporter", { ...before, observedAt: now + 1 }, now),
      /conflicts/u,
    );
    assert.throws(() => {
      store.observe([{ ...evidence, observedAt: now + 1001 }], now + 1000);
    }, /conflicts/u);
    assert.equal(
      store.list(undefined, 100, now + ATTEMPT_DEADLINE_MS + ATTEMPT_RETENTION_MS + 2).length,
      0,
    );
    assert.equal(MAX_ATTEMPT_RECORDS, 10_000);
  } finally {
    store.close();
  }
});

void test("each mutation requires an exclusive durable claim and terminal reports cannot create a claim", () => {
  const store = openRawStore(":memory:");
  try {
    const record = store.intent(intent, "reporter", before, now);
    const report = { attemptId: record.id, stage: "tag-write", result: "started" } as const;
    assert.throws(
      () => store.report({ ...report, result: "acknowledged" }, "reporter", now),
      /conflicts/u,
    );
    assert.equal(store.report(report, "reporter", now).tagWrite, "started");
    assert.throws(() => store.report(report, "reporter", now), /conflicts/u);
    assert.equal(
      store.report({ ...report, result: "acknowledged" }, "reporter", now).tagWrite,
      "acknowledged",
    );
    assert.throws(() => store.report(report, "reporter", now), /conflicts/u);
    const queue = { attemptId: record.id, stage: "queue", result: "started" } as const;
    store.report(queue, "reporter", now);
    store.observe([evidence], now + 1000);
    assert.equal(store.list(undefined, 10, now + 1000)[0]!.outcome, "incomplete");
    store.report({ ...queue, result: "unknown" }, "reporter", now + 1001);
    store.observe([{ ...evidence, observedAt: now + 1002 }], now + 1002);
    assert.equal(store.list(undefined, 10, now + 1002)[0]!.outcome, "landed");
  } finally {
    store.close();
  }
});

void test("capacity refuses new intent while preserving active attempts and idempotent retries", () => {
  const directory = mkdtempSync(join(tmpdir(), "attempt-capacity-"));
  try {
    const path = join(directory, "db.sqlite");
    const store = openRawStore(path);
    const first = store.intent(intent, "reporter", before, now);
    const db = new Database(path);
    const insert = db.prepare(
      "INSERT INTO deployment_attempts (id, request_key, requested_at, record) VALUES (?, ?, ?, ?)",
    );
    db.transaction(() => {
      for (let index = 1; index < MAX_ATTEMPT_RECORDS; index++) {
        const id = `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
        insert.run(id, `fixture-${index}`, now, JSON.stringify({ ...first, id }));
      }
    })();
    assert.throws(
      () => store.intent({ ...intent, runId: "222" }, "reporter", before, now),
      /capacity/u,
    );
    assert.deepEqual(store.intent(intent, "reporter", before, now), first);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM deployment_attempts").get() as { count: number })
        .count,
      MAX_ATTEMPT_RECORDS,
    );
    store.close();
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("schema setup failure closes its database before reporting the error", () => {
  const directory = mkdtempSync(join(tmpdir(), "attempt-invalid-db-"));
  try {
    const path = join(directory, "db.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE deployment_attempts (unrelated TEXT)");
    db.close();
    assert.throws(() => openRawStore(path), /requested_at/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("expired intent cannot authorize a new deployment mutation", () => {
  const store = openRawStore(":memory:");
  try {
    const record = store.intent(intent, "reporter", before, now);
    assert.throws(
      () =>
        store.report(
          { attemptId: record.id, stage: "tag-write", result: "started" },
          "reporter",
          record.deadlineAt,
        ),
      /conflicts/u,
    );
  } finally {
    store.close();
  }
});

void test("recreation observed before the durable queue claim cannot establish landing after restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "attempt-queue-time-"));
  try {
    const path = join(directory, "db.sqlite");
    let store = openRawStore(path);
    const record = store.intent(intent, "reporter", before, now);
    store.report({ attemptId: record.id, stage: "tag-write", result: "started" }, "reporter", now);
    store.report(
      { attemptId: record.id, stage: "tag-write", result: "acknowledged" },
      "reporter",
      now,
    );
    const queue = { attemptId: record.id, stage: "queue" } as const;
    store.report({ ...queue, result: "started" }, "reporter", now + 2000);
    store.report({ ...queue, result: "acknowledged" }, "reporter", now + 3000);
    store.close();
    store = openRawStore(path);
    store.observe([evidence], now + 3001);
    const unchanged = store.list("api", 1, now + 3001)[0]!;
    assert.equal(unchanged.outcome, "queued");
    assert.equal(unchanged.landedAt, null);
    assert.equal(unchanged.after, null);
    assert.equal(unchanged.queueClaimedAt, now + 2000);
    store.report({ ...queue, result: "acknowledged" }, "reporter", now + 3002);
    assert.equal(store.list("api", 1, now + 3002)[0]!.queueClaimedAt, now + 2000);
    store.observe([{ ...evidence, observedAt: now + 4000 }], now + 4000);
    assert.equal(store.list("api", 1, now + 4000)[0]!.outcome, "landed");
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("legacy attempts without queue timing remain readable but cannot establish landing", () => {
  const directory = mkdtempSync(join(tmpdir(), "attempt-legacy-queue-"));
  try {
    const path = join(directory, "db.sqlite");
    const store = openDeploymentAttemptStore(path);
    const record = store.intent(intent, "reporter", before, now);
    store.report(
      { attemptId: record.id, stage: "tag-write", result: "acknowledged" },
      "reporter",
      now,
    );
    store.report({ attemptId: record.id, stage: "queue", result: "acknowledged" }, "reporter", now);
    const db = new Database(path);
    const legacy = { ...store.list("api", 1, now)[0]! };
    const { queueClaimedAt, ...withoutClaim } = legacy;
    assert.equal(queueClaimedAt, now);
    db.prepare("UPDATE deployment_attempts SET record = ? WHERE id = ?").run(
      JSON.stringify(withoutClaim),
      record.id,
    );
    db.close();
    store.observe([evidence], now + 1000);
    const preserved = store.list("api", 1, now + 1000)[0]!;
    assert.equal(preserved.queueClaimedAt, null);
    assert.equal(preserved.outcome, "queued");
    assert.equal(preserved.after, null);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
