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
    assert.throws(() =>
      second.intent(
        { ...intent, trigger: "rollback" } as unknown as DeployAttemptIntent,
        "reporter",
        before,
        now,
      ),
    );
    assert.throws(
      () => second.intent({ ...intent, runAttempt: 2 }, "reporter", before, now + 10),
      /conflicts/u,
    );
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

void test("overlapping and expired queued requests refuse new CI intents across restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "attempt-overlap-"));
  try {
    const path = join(directory, "db.sqlite");
    let store = openDeploymentAttemptStore(path);
    const first = store.intent(intent, "reporter", before, now);
    for (const stage of ["tag-write", "queue"] as const)
      store.report({ attemptId: first.id, stage, result: "acknowledged" }, "reporter", now);
    store.close();
    store = openDeploymentAttemptStore(path);
    assert.throws(
      () => store.intent({ ...intent, runId: "124" }, "reporter", before, first.deadlineAt),
      /conflicts/u,
    );
    store.observe([{ ...evidence, observedAt: first.deadlineAt + 1 }], first.deadlineAt + 1);
    assert.equal(
      store.get("api", first.id, first.deadlineAt + 1)!.lateLandedAt,
      first.deadlineAt + 1,
    );
    assert.equal(
      store.intent({ ...intent, runId: "124" }, "reporter", before, first.deadlineAt + 2)
        .correlation,
      "pending",
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

void test("expired unstarted or acknowledged writes release reservations while uncertain writes remain blocked", () => {
  for (const tagResult of [null, "started", "acknowledged", "unknown"] as const) {
    const directory = mkdtempSync(join(tmpdir(), "attempt-unclaimed-expiry-"));
    try {
      const path = join(directory, "db.sqlite");
      let store = openRawStore(path);
      const abandoned = store.intent(intent, "reporter", before, now);
      if (tagResult !== null) {
        store.report(
          { attemptId: abandoned.id, stage: "tag-write", result: "started" },
          "reporter",
          now,
        );
        if (tagResult !== "started")
          store.report(
            { attemptId: abandoned.id, stage: "tag-write", result: tagResult },
            "reporter",
            now,
          );
      }
      store.close();
      store = openRawStore(path);
      const later = abandoned.deadlineAt;
      if (tagResult === "started" || tagResult === "unknown") {
        assert.throws(
          () => store.intent({ ...intent, runId: "124" }, "reporter", before, later),
          /conflicts/u,
        );
        store.close();
        continue;
      }
      const next = store.intent({ ...intent, runId: "124" }, "reporter", before, later);
      assert.equal(next.correlation, "pending");
      if (tagResult === "acknowledged")
        assert.throws(
          () =>
            store.report(
              { attemptId: abandoned.id, stage: "queue", result: "started" },
              "reporter",
              later,
            ),
          /conflicts/u,
        );
      for (const stage of ["tag-write", "queue"] as const)
        for (const result of ["started", "acknowledged"] as const)
          store.report({ attemptId: next.id, stage, result }, "reporter", later);
      store.observe([{ ...evidence, observedAt: later + 1 }], later + 1);
      const records = store.list("api", 100, later + 1);
      assert.equal(records.find((record) => record.id === next.id)!.outcome, "landed");
      assert.equal(records.find((record) => record.id === abandoned.id)!.outcome, "timed-out");
      assert.equal(
        store.intent({ ...intent, runId: "125" }, "reporter", before, later + 2).correlation,
        "pending",
      );
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

void test("an expired queue claim refuses later requests even without a completion report", () => {
  const store = openRawStore(":memory:");
  try {
    const first = store.intent(intent, "reporter", before, now);
    for (const result of ["started", "acknowledged"] as const)
      store.report({ attemptId: first.id, stage: "tag-write", result }, "reporter", now);
    store.report({ attemptId: first.id, stage: "queue", result: "started" }, "reporter", now);
    assert.throws(
      () => store.intent({ ...intent, runId: "124" }, "reporter", before, first.deadlineAt),
      /conflicts/u,
    );
    assert.equal(store.get("api", first.id, first.deadlineAt)!.correlation, "pending");
  } finally {
    store.close();
  }
});

void test("manual reservations are durable, attributed and idempotent across store connections", () => {
  const directory = mkdtempSync(join(tmpdir(), "manual-attempt-"));
  try {
    const path = join(directory, "db.sqlite");
    const first = openRawStore(path);
    const second = openRawStore(path);
    const input = {
      app: "api",
      requestId: "00000000-0000-4000-8000-000000000001",
      actorUserId: "verified-admin",
    };
    assert.equal(second.findManual(input, "api-service", now), undefined);
    const reservation = first.reserveManual(input, "api-service", before, now);
    assert.deepEqual(second.findManual(input, "api-service", now), reservation.attempt);
    assert.throws(
      () => second.findManual({ ...input, app: "web" }, "api-service", now),
      /conflicts/u,
    );
    assert.throws(() => second.findManual(input, "other-service", now), /conflicts/u);
    assert.equal(reservation.created, true);
    assert.equal(reservation.attempt.image, null);
    assert.equal(reservation.attempt.runId, null);
    assert.equal(reservation.attempt.runAttempt, null);
    assert.equal(reservation.attempt.actorUserId, input.actorUserId);
    assert.equal(reservation.attempt.tagWrite, null);
    assert.deepEqual(second.reserveManual(input, "api-service", null, now + 1), {
      attempt: reservation.attempt,
      created: false,
    });
    assert.throws(
      () => second.reserveManual({ ...input, app: "web" }, "api-service", null, now),
      /conflicts/u,
    );
    assert.throws(() => second.reserveManual(input, "other-service", null, now), /conflicts/u);
    assert.throws(
      () =>
        second.reserveManual(
          { ...input, requestId: "00000000-0000-4000-8000-000000000002" },
          "api-service",
          null,
          now,
        ),
      /conflicts/u,
    );
    assert.throws(
      () =>
        second.reserveManual({ ...input, actorUserId: "other-admin" }, "api-service", null, now),
      /conflicts/u,
    );
    assert.equal(second.list("api", 100, now).length, 1);
    first.close();
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("manual queue claims record recreation without claiming an unspecified image landed", () => {
  const store = openRawStore(":memory:");
  try {
    const input = {
      app: "api",
      requestId: "00000000-0000-4000-8000-000000000001",
      actorUserId: "admin",
    };
    const { attempt } = store.reserveManual(input, "api-service", before, now);
    assert.throws(
      () =>
        store.report(
          { attemptId: attempt.id, stage: "tag-write", result: "started" },
          "api-service",
          now,
        ),
      /conflicts/u,
    );
    assert.throws(
      () =>
        store.report(
          { attemptId: attempt.id, stage: "queue", result: "acknowledged" },
          "api-service",
          now,
        ),
      /conflicts/u,
    );
    store.report({ attemptId: attempt.id, stage: "queue", result: "started" }, "api-service", now);
    assert.equal(
      store.report(
        { attemptId: attempt.id, stage: "queue", result: "acknowledged" },
        "api-service",
        now,
      ).outcome,
      "queued",
    );
    store.observe([evidence], now + 1000);
    const observed = store.get("api", attempt.id, now + 1000)!;
    assert.equal(observed.image, null);
    assert.equal(observed.outcome, "recreated");
    assert.equal(observed.correlation, "pending");
    assert.deepEqual(observed.after, {
      containerId: evidence.containerId,
      observedAt: evidence.observedAt,
      image: evidence.image,
    });
    assert.equal(observed.recreatedAt, evidence.observedAt);
    assert.equal(observed.landedAt, null);
    assert.equal(observed.lateLandedAt, null);
    assert.equal(observed.tagWrite, null);
    store.observe([{ ...evidence, observedAt: now + 2000 }], now + 2000);
    assert.equal(store.get("api", attempt.id, now + 2000)!.recreatedAt, evidence.observedAt);
    assert.equal(
      store.reserveManual(
        { ...input, requestId: "00000000-0000-4000-8000-000000000002" },
        "api-service",
        null,
        now + 2000,
      ).created,
      true,
    );
  } finally {
    store.close();
  }
});

void test("unresolved manual queue claims survive retention and late recreation preserves timeout while resolving overlap", () => {
  const directory = mkdtempSync(join(tmpdir(), "manual-late-recreation-"));
  try {
    const path = join(directory, "db.sqlite");
    let store = openRawStore(path);
    const input = {
      app: "api",
      requestId: "00000000-0000-4000-8000-000000000001",
      actorUserId: "admin",
    };
    const { attempt } = store.reserveManual(input, "api-service", before, now);
    store.report({ attemptId: attempt.id, stage: "queue", result: "started" }, "api-service", now);
    store.report({ attemptId: attempt.id, stage: "queue", result: "unknown" }, "api-service", now);
    store.close();
    store = openRawStore(path);
    const late = attempt.deadlineAt + ATTEMPT_RETENTION_MS + 1;
    const next = { ...input, requestId: "00000000-0000-4000-8000-000000000002" };
    assert.throws(() => store.reserveManual(next, "api-service", null, late), /conflicts/u);
    assert.equal(store.get("api", attempt.id, late)!.outcome, "timed-out");
    store.observe([{ ...evidence, observedAt: late }], late);
    // Read before retention can prune the now-resolved record.
    const db = new Database(path);
    const row = db
      .prepare("SELECT record FROM deployment_attempts WHERE id = ?")
      .get(attempt.id) as { record: string };
    const record = JSON.parse(row.record) as {
      outcome: string;
      recreatedAt: number;
      landedAt: null;
      lateLandedAt: null;
    };
    assert.equal(record.outcome, "timed-out");
    assert.equal(record.recreatedAt, late);
    assert.equal(record.landedAt, null);
    assert.equal(record.lateLandedAt, null);
    db.close();
    assert.equal(store.reserveManual(next, "api-service", null, late + 1).created, true);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("manual recreation needs an unambiguous changed container after its durable queue claim", () => {
  for (const example of [
    { baseline: null, sample: evidence, queue: true, ambiguous: false },
    {
      baseline: before,
      sample: { ...evidence, containerId: before.containerId },
      queue: true,
      ambiguous: false,
    },
    {
      baseline: before,
      sample: { ...evidence, observedAt: now - 1 },
      queue: true,
      ambiguous: false,
    },
    { baseline: before, sample: { ...evidence, app: "web" }, queue: true, ambiguous: false },
    { baseline: before, sample: { ...evidence, observedAt: now }, queue: true, ambiguous: false },
    { baseline: before, sample: evidence, queue: false, ambiguous: false },
  ]) {
    const store = openRawStore(":memory:");
    try {
      const { attempt } = store.reserveManual(
        { app: "api", requestId: "00000000-0000-4000-8000-000000000001", actorUserId: "admin" },
        "api-service",
        example.baseline,
        now,
      );
      if (example.queue) {
        store.report(
          { attemptId: attempt.id, stage: "queue", result: "started" },
          "api-service",
          now + 1,
        );
        store.report(
          { attemptId: attempt.id, stage: "queue", result: "acknowledged" },
          "api-service",
          now + 1,
        );
      }
      if (example.ambiguous)
        assert.throws(() => store.intent(intent, "ci", before, now + 1), /conflicts/u);
      store.observe([example.sample], now + 1000);
      const observed = store.get("api", attempt.id, now + 1000)!;
      assert.equal(observed.after, null);
      assert.equal(observed.recreatedAt, null);
      assert.notEqual(observed.outcome, "recreated");
    } finally {
      store.close();
    }
  }
});

void test("manual reservations and CI intents mutually reject unresolved work", () => {
  for (const result of ["started", "acknowledged", "unknown"] as const) {
    const store = openRawStore(":memory:");
    try {
      const ci = store.intent(intent, "ci", before, now);
      const manual = {
        app: "api",
        requestId: "00000000-0000-4000-8000-000000000001",
        actorUserId: "admin",
      };
      assert.throws(() => store.reserveManual(manual, "api-service", before, now), /conflicts/u);
      for (const tagResult of ["started", "acknowledged"] as const)
        store.report({ attemptId: ci.id, stage: "tag-write", result: tagResult }, "ci", now);
      store.report({ attemptId: ci.id, stage: "queue", result: "started" }, "ci", now);
      if (result !== "started")
        store.report({ attemptId: ci.id, stage: "queue", result }, "ci", now);
      assert.throws(
        () => store.reserveManual(manual, "api-service", before, ci.deadlineAt),
        /conflicts/u,
      );
    } finally {
      store.close();
    }
  }
  const store = openRawStore(":memory:");
  try {
    const manual = store.reserveManual(
      { app: "api", requestId: "00000000-0000-4000-8000-000000000001", actorUserId: "admin" },
      "api-service",
      before,
      now,
    );
    assert.throws(() => store.intent(intent, "ci", before, now), /conflicts/u);
    assert.equal(store.get("api", manual.attempt.id, now)!.correlation, "pending");
  } finally {
    store.close();
  }
});

void test("rejected manual queueing releases overlap refusal without allowing a retry to submit twice", () => {
  const store = openRawStore(":memory:");
  try {
    const input = {
      app: "api",
      requestId: "00000000-0000-4000-8000-000000000001",
      actorUserId: "admin",
    };
    const { attempt } = store.reserveManual(input, "api-service", before, now);
    store.report({ attemptId: attempt.id, stage: "queue", result: "started" }, "api-service", now);
    store.report({ attemptId: attempt.id, stage: "queue", result: "rejected" }, "api-service", now);
    const retry = store.reserveManual(input, "api-service", before, now + 1);
    assert.equal(retry.created, false);
    assert.equal(retry.attempt.outcome, "failed");
    const next = store.reserveManual(
      { ...input, requestId: "00000000-0000-4000-8000-000000000002" },
      "api-service",
      before,
      now + 1,
    );
    assert.equal(next.created, true);
  } finally {
    store.close();
  }
});

void test("rollback selects landed immutable evidence and reserves atomically across connections", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollback-store-"));
  try {
    const path = join(directory, "db.sqlite");
    const store = openDeploymentAttemptStore(path);
    const target = store.intent(intent, "ci", before, now);
    const input = {
      app: "api",
      requestId: "00000000-0000-4000-8000-000000000001",
      actorUserId: "admin",
      targetAttemptId: target.id,
    };
    assert.equal(store.findRollback(input, "api-service", now), undefined);
    assert.throws(() => store.reserveRollback(input, "api-service", before, now), /conflicts/u);
    for (const stage of ["tag-write", "queue"] as const)
      store.report({ attemptId: target.id, stage, result: "acknowledged" }, "ci", now);
    store.observe([evidence], now + 1000);
    const second = openRawStore(path);
    assert.throws(
      () => second.reserveRollback({ ...input, app: "web" }, "api-service", null, now + 1000),
      /conflicts/u,
    );
    assert.throws(() => second.reserveRollback(input, "", null, now + 1000), /conflicts/u);
    assert.throws(
      () =>
        second.reserveRollback(
          input,
          "api-service",
          { ...before, observedAt: now + 2000 },
          now + 1000,
        ),
      /conflicts/u,
    );
    const reservation = store.reserveRollback(
      input,
      "api-service",
      { containerId: evidence.containerId, observedAt: now + 1000 },
      now + 1001,
    );
    assert.equal(reservation.created, true);
    assert.equal(reservation.attempt.trigger, "rollback");
    assert.deepEqual(reservation.attempt.image, intent.image);
    assert.equal(reservation.attempt.runId, null);
    assert.equal(reservation.attempt.actorUserId, "admin");
    assert.equal(reservation.attempt.targetAttemptId, target.id);
    assert.deepEqual(second.findRollback(input, "api-service", now + 1001), reservation.attempt);
    assert.equal(second.reserveRollback(input, "api-service", null, now + 1001).created, false);
    for (const change of [
      { app: "web" },
      { targetAttemptId: "00000000-0000-4000-8000-000000000003" },
    ])
      assert.throws(
        () => second.findRollback({ ...input, ...change }, "api-service", now + 1001),
        /conflicts/u,
      );
    assert.throws(() => second.findRollback(input, "other", now + 1001), /conflicts/u);
    assert.throws(
      () =>
        second.reserveRollback(
          { ...input, requestId: "00000000-0000-4000-8000-000000000002" },
          "api-service",
          null,
          now + 1001,
        ),
      /conflicts/u,
    );
    assert.throws(
      () => second.intent({ ...intent, runId: "124" }, "ci", before, now + 1001),
      /conflicts/u,
    );
    assert.throws(() => second.reserveManual(input, "api-service", before, now + 1001));
    assert.throws(
      () => second.claimExecution("web", reservation.attempt.id, "api-service", now + 1001, before),
      /conflicts/u,
    );
    assert.throws(
      () => second.claimExecution("api", reservation.attempt.id, "other", now + 1001, before),
      /conflicts/u,
    );
    assert.equal(
      second.claimExecution("api", reservation.attempt.id, "api-service", now + 1001, before)
        .claimed,
      true,
    );
    assert.equal(
      store.claimExecution("api", reservation.attempt.id, "api-service", now + 1001, before)
        .claimed,
      false,
    );
    store.report(
      { attemptId: reservation.attempt.id, stage: "tag-write", result: "acknowledged" },
      "api-service",
      now + 1001,
    );
    store.report(
      { attemptId: reservation.attempt.id, stage: "queue", result: "acknowledged" },
      "api-service",
      now + 1001,
    );
    store.observe(
      [{ ...evidence, containerId: "e".repeat(64), observedAt: now + 2000 }],
      now + 2000,
    );
    assert.equal(store.get("api", reservation.attempt.id, now + 2000)!.outcome, "landed");
    assert.equal(
      second.intent({ ...intent, runId: "124" }, "ci", before, now + 2001).correlation,
      "pending",
    );
    second.close();
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("execution cannot claim expired intent or manual request", () => {
  const store = openRawStore(":memory:");
  try {
    const attempt = store.intent(intent, "ci", before, now);
    assert.throws(
      () => store.claimExecution("api", attempt.id, "ci", attempt.deadlineAt, before),
      /conflicts/u,
    );
    const manual = store.reserveManual(
      { app: "web", requestId: "00000000-0000-4000-8000-000000000001", actorUserId: "admin" },
      "api-service",
      before,
      now,
    );
    assert.throws(
      () => store.claimExecution("web", manual.attempt.id, "api-service", now, before),
      /conflicts/u,
    );
  } finally {
    store.close();
  }
});

void test("execution atomically refreshes its baseline once and rejects stale or future evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "execution-baseline-"));
  try {
    const path = join(directory, "db.sqlite");
    const first = openRawStore(path);
    const record = first.intent(intent, "ci", before, now);
    const executionTime = now + 60_000;
    for (const observedAt of [now, executionTime + 1]) {
      assert.throws(
        () =>
          first.claimExecution("api", record.id, "ci", executionTime, { ...before, observedAt }),
        /conflicts/u,
      );
      assert.equal(first.get("api", record.id, executionTime)!.tagWrite, null);
      assert.deepEqual(first.get("api", record.id, executionTime)!.baseline, before);
    }
    const refreshed = { containerId: "e".repeat(64), observedAt: executionTime };
    assert.equal(
      first.claimExecution("api", record.id, "ci", executionTime, refreshed).claimed,
      true,
    );
    first.close();
    const second = openRawStore(path);
    assert.deepEqual(second.get("api", record.id, executionTime)!.baseline, refreshed);
    const duplicate = second.claimExecution("api", record.id, "ci", executionTime, before);
    assert.equal(duplicate.claimed, false);
    assert.deepEqual(duplicate.attempt.baseline, refreshed);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
