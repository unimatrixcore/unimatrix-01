import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import type { DeployAttemptIntent, DeployAttemptRecord } from "@unimatrix/shared";

import { openDeploymentAttemptStore } from "../src/attempts/store.js";

const now = 1_000_000;
const before = { containerId: "a".repeat(64), observedAt: now };
function intent(app: string): DeployAttemptIntent {
  return {
    repository: "unimatrixcore/unimatrix-01",
    runId: "123",
    runAttempt: 1,
    app,
    trigger: "ci",
    image: {
      repository: `ghcr.io/unimatrixcore/unimatrix-${app}`,
      tag: "main",
      commit: "b".repeat(40),
      platform: "linux/amd64",
      digestKind: "manifest",
      digest: `sha256:${"c".repeat(64)}`,
    },
  };
}
const inputs = [intent("admin"), intent("api"), intent("web")];
const baselines = new Map(inputs.map((input) => [input.app, before]));
void test("batch atomically reserves all requested apps and exact retries retain every original ID", () => {
  const store = openDeploymentAttemptStore(":memory:");
  try {
    const rows = store.intentBatch(inputs, "reporter", baselines, now);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => row.app),
      ["admin", "api", "web"],
    );
    const retried = store.intentBatch(inputs, "reporter", baselines, now + 1);
    assert.deepEqual(
      retried.map((row) => row.id),
      rows.map((row) => row.id),
    );
    assert.equal(store.list(undefined, 100, now + 1).length, 3);
  } finally {
    store.close();
  }
});
for (const conflictingApp of ["api", "web"]) {
  void test(`a conflict on ${conflictingApp} leaves no earlier new batch reservations`, () => {
    const store = openDeploymentAttemptStore(":memory:");
    try {
      const manual = store.reserveManual(
        {
          app: conflictingApp,
          actorUserId: "user",
          requestId: "00000000-0000-4000-8000-000000000001",
        },
        "api-admin",
        before,
        now,
      ).attempt;
      assert.throws(() => store.intentBatch(inputs, "reporter", baselines, now + 1));
      assert.deepEqual(
        store.list(undefined, 100, now + 1).map((row) => row.id),
        [manual.id],
      );
    } finally {
      store.close();
    }
  });
}
void test("invalid duplicate, mixed-run, missing baseline or reporter batch cannot reserve any app", () => {
  const store = openDeploymentAttemptStore(":memory:");
  try {
    for (const invalid of [
      [],
      [inputs[0]!, inputs[0]!],
      [inputs[0]!, { ...inputs[1]!, repository: "other/repository" }],
      [inputs[0]!, { ...inputs[1]!, runId: "124" }],
      [inputs[0]!, { ...inputs[1]!, runAttempt: 2 }],
      Array.from({ length: 65 }, (_, i) => intent(`app-${i}`)),
    ]) {
      assert.throws(() => store.intentBatch(invalid, "reporter", baselines, now));
    }
    assert.throws(() => store.intentBatch(inputs, "", baselines, now));
    assert.throws(() => store.intentBatch(inputs, "reporter", new Map(), now));
    assert.throws(() =>
      store.intentBatch(
        inputs,
        "reporter",
        new Map(inputs.map((input) => [input.app, { ...before, observedAt: now + 1 }])),
        now,
      ),
    );
    assert.equal(store.list(undefined, 100, now).length, 0);
  } finally {
    store.close();
  }
});
for (const patch of [
  { tagWrite: "started" },
  { tagWrite: "acknowledged" },
  { tagWrite: "unknown" },
  { queue: "started" },
  { queue: "acknowledged" },
  { queue: "unknown" },
  { queueClaimedAt: now },
  { outcome: "already-current" },
  { outcome: "failed" },
  { completedAt: now },
  { correlation: "ambiguous" },
]) {
  void test(`an existing non-executable record ${JSON.stringify(patch)} rolls back newly reserved batch entries`, () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-batch-"));
    const path = join(dir, "deploy.sqlite");
    const store = openDeploymentAttemptStore(path);
    try {
      const prior = store.intent(inputs[2]!, "reporter", before, now);
      const db = new Database(path);
      db.prepare("UPDATE deployment_attempts SET record = ? WHERE id = ?").run(
        JSON.stringify({ ...prior, ...patch }),
        prior.id,
      );
      db.close();
      assert.throws(() => store.intentBatch(inputs, "reporter", baselines, now + 1));
      const read = new Database(path, { readonly: true });
      const raw = read.prepare("SELECT record FROM deployment_attempts").all() as {
        record: string;
      }[];
      assert.equal(raw.length, 1);
      assert.equal((JSON.parse(raw[0]!.record) as DeployAttemptRecord).id, prior.id);
      read.close();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
