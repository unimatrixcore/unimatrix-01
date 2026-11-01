import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { DeployAttemptIntent, DeployAttemptRecord } from "@unimatrix/shared";

import { openDeploymentAttemptStore } from "../src/attempts/store.js";
import { runDeploymentAttemptsCli } from "../src/cli/attempts.js";

const now = 1_000_000;
const baseline = { containerId: "a".repeat(64), observedAt: now };
const input: DeployAttemptIntent = {
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
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cancel-unused-ci-"));
  const path = join(dir, "deploy.sqlite");
  const store = openDeploymentAttemptStore(path);
  const first = store.intent(input, "reporter", baseline, now);
  const second = store.intent({ ...input, app: "admin" }, "reporter", baseline, now);
  const manifest = {
    repository: input.repository,
    runId: input.runId,
    runAttempt: 1,
    reporterId: "reporter",
    attemptIds: [first.id, second.id],
  };
  return {
    store,
    path,
    first,
    second,
    manifest,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
void test("host-local cancellation releases exact untouched CI cohort without deleting history or permitting late execution", () => {
  const f = fixture();
  try {
    const cancelled = f.store.cancelUnusedCi(f.manifest, now + 1);
    assert.equal(cancelled.length, 2);
    for (const record of cancelled) {
      assert.equal(record.outcome, "failed");
      assert.equal(record.tagWrite, null);
      assert.equal(record.queue, null);
      assert.equal(record.completedAt, now + 1);
      assert.equal(record.failureReason, null);
      assert.throws(() =>
        f.store.claimExecution(record.app, record.id, "reporter", now + 2, baseline),
      );
      assert.throws(() =>
        f.store.report(
          { attemptId: record.id, stage: "tag-write", result: "started" },
          "reporter",
          now + 2,
        ),
      );
    }
    assert.deepEqual(
      f.store.get("api", f.first.id, now + 2),
      cancelled.find((r) => r.id === f.first.id),
    );
    assert.throws(() => f.store.cancelUnusedCi(f.manifest, now + 2));
    assert.equal(
      f.store.intent({ ...input, runAttempt: 2 }, "reporter", baseline, now + 2).runAttempt,
      2,
    );
  } finally {
    f.close();
  }
});
void test("cancellation refuses missing, duplicated, foreign-caller and mismatched-run selectors atomically", () => {
  const f = fixture();
  try {
    for (const manifest of [
      { ...f.manifest, attemptIds: [f.first.id] },
      { ...f.manifest, attemptIds: [f.first.id, f.first.id] },
      { ...f.manifest, reporterId: "other" },
      { ...f.manifest, runId: "124" },
      { ...f.manifest, runAttempt: 2 },
      { ...f.manifest, repository: "other/repository" },
      { ...f.manifest, attemptIds: [] },
      { ...f.manifest, attemptIds: [f.first.id, "00000000-0000-4000-8000-000000000001"] },
    ])
      assert.throws(() => f.store.cancelUnusedCi(manifest, now + 1));
    assert.equal(f.store.get("api", f.first.id, now + 1)?.outcome, "incomplete");
    assert.equal(f.store.get("admin", f.second.id, now + 1)?.outcome, "incomplete");
    assert.throws(() => f.store.cancelUnusedCi(f.manifest, -1));
  } finally {
    f.close();
  }
});
for (const patch of [
  ...["started", "acknowledged", "unknown", "rejected"].map((tagWrite) => ({ tagWrite })),
  ...["started", "acknowledged", "unknown", "rejected"].map((queue) => ({ queue })),
  { queueClaimedAt: now },
  { outcome: "queued" },
  { correlation: "ambiguous" },
  { completedAt: now },
  { recreatedAt: now },
  { landedAt: now },
  { lateLandedAt: now },
  { trigger: "manual" },
  { image: null },
  {
    after: {
      containerId: "d".repeat(64),
      observedAt: now,
      image: {
        repository: input.image.repository,
        platform: "linux/amd64",
        digestKind: "manifest",
        digest: input.image.digest,
      },
    },
  },
]) {
  void test(`cancellation preserves the whole cohort when one record has ${JSON.stringify(patch)}`, () => {
    const f = fixture();
    try {
      const db = new Database(f.path);
      const changed = { ...f.second, ...patch } as DeployAttemptRecord;
      db.prepare("UPDATE deployment_attempts SET record = ? WHERE id = ?").run(
        JSON.stringify(changed),
        f.second.id,
      );
      db.close();
      assert.throws(() => f.store.cancelUnusedCi(f.manifest, now + 1));
      const verify = new Database(f.path, { readonly: true });
      const row = verify
        .prepare("SELECT record FROM deployment_attempts WHERE id = ?")
        .get(f.first.id) as { record: string };
      assert.equal((JSON.parse(row.record) as DeployAttemptRecord).outcome, "incomplete");
      verify.close();
    } finally {
      f.close();
    }
  });
}
void test("CLI accepts only explicit manifest and sanitizes invalid file or cancellation failures", () => {
  const f = fixture();
  const lines: string[] = [];
  const deps = {
    store: f.store,
    readManifest: () => f.manifest,
    now: () => now + 1,
    write: (line: string) => {
      lines.push(line);
    },
  };
  try {
    for (const args of [
      [],
      ["unknown"],
      ["cancel-unused", "--manifest", ""],
      ["cancel-unused", "--other", "file"],
    ])
      assert.equal(runDeploymentAttemptsCli(args, deps), 2);
    assert.equal(
      runDeploymentAttemptsCli(["cancel-unused", "--manifest", "file"], {
        ...deps,
        readManifest() {
          throw new Error("private value");
        },
      }),
      1,
    );
    assert.equal(lines.at(-1), "Unused CI reservation cancellation refused.");
    assert.equal(runDeploymentAttemptsCli(["cancel-unused", "--manifest", "file"], deps), 0);
    assert.deepEqual(JSON.parse(lines.at(-1)!), { cancelled: 2, apps: ["api", "admin"] });
  } finally {
    f.close();
  }
});

void test("a competing execution claim on another connection prevents cancellation of every selected reservation", () => {
  const f = fixture();
  const competitor = openDeploymentAttemptStore(f.path);
  try {
    competitor.claimExecution("admin", f.second.id, "reporter", now + 1, baseline);
    assert.throws(() => f.store.cancelUnusedCi(f.manifest, now + 2));
    assert.equal(f.store.get("api", f.first.id, now + 2)?.outcome, "incomplete");
    assert.equal(competitor.get("admin", f.second.id, now + 2)?.tagWrite, "started");
  } finally {
    competitor.close();
    f.close();
  }
});
void test("real host-local CLI needs no HTTP credentials and refuses invalid manifests without echoing them", () => {
  const directory = mkdtempSync(join(tmpdir(), "cancel-unused-cli-"));
  const path = join(directory, "deploy.sqlite");
  const manifestPath = join(directory, "manifest.json");
  const time = Date.now();
  const store = openDeploymentAttemptStore(path);
  const cli = fileURLToPath(new URL("../src/cli/attempts.ts", import.meta.url));
  const run = (args: string[], databasePath = path) =>
    spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, DEPLOY_DATABASE_PATH: databasePath, NODE_ENV: "production" },
    });
  try {
    const row = store.intent(input, "reporter", { ...baseline, observedAt: time }, time);
    writeFileSync(
      manifestPath,
      JSON.stringify({
        repository: input.repository,
        runId: input.runId,
        runAttempt: 1,
        reporterId: "reporter",
        attemptIds: [row.id],
      }),
    );
    assert.equal(run([]).status, 2);
    assert.equal(run(["cancel-unused", "--manifest", manifestPath], " ").status, 2);
    const failed = run(["cancel-unused", "--manifest", "missing-private-value"]);
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout.trim(), "Unused CI reservation cancellation refused.");
    assert.equal(failed.stderr, "");
    const done = run(["cancel-unused", "--manifest", manifestPath]);
    assert.ifError(done.error);
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(JSON.parse(done.stdout), { cancelled: 1, apps: ["api"] });
    assert.equal(store.get("api", row.id, Date.now())?.outcome, "failed");
    assert.equal(run(["cancel-unused", "--manifest", manifestPath]).status, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
