import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  DAY_MS,
  HISTORY_RETENTION_MS,
  PROBE_INTERVAL_MS,
  summarizeHealth,
} from "../src/health-history/model.js";
import { openHealthHistoryStore } from "../src/health-history/store.js";

const NOW = 1_800_000_000_000;

void test("uptime weights observed durations and leaves gaps unknown", () => {
  const result = summarizeHealth(
    [
      { app: "api", checkedAt: NOW, state: "up" },
      { app: "api", checkedAt: NOW + 30_000, state: "down" },
      { app: "api", checkedAt: NOW + 180_000, state: "unknown" },
    ],
    NOW,
    NOW + 240_000,
  );
  assert.equal(result.upMs, 30_000);
  assert.equal(result.downMs, 60_000);
  assert.equal(result.unknownMs, 150_000);
  assert.equal(result.uptimePercent, 100 / 3);
  assert.equal(result.coveragePercent, 37.5);
  assert.equal(summarizeHealth([], NOW, NOW + DAY_MS).uptimePercent, null);
  assert.equal(summarizeHealth([], NOW, NOW).coveragePercent, 0);
  assert.throws(() => summarizeHealth([], NOW, NOW - 1), /ordered/);
  assert.throws(() => summarizeHealth([], -1, NOW), /ordered/);
});

void test("history persists across reopen, expires freshness, and replaces a same-minute sample", () => {
  const directory = mkdtempSync(join(tmpdir(), "deploy-history-"));
  const path = join(directory, "nested", "history.sqlite");
  let store = openHealthHistoryStore(path, ["api"], NOW);
  try {
    assert.deepEqual(store.snapshot("api", NOW).current, {
      app: "api",
      checkedAt: null,
      state: "unknown",
    });
    store.record({ app: "api", checkedAt: NOW, state: "up" }, NOW);
    store.close();
    store = openHealthHistoryStore(path, ["api"], NOW + 1_000);
    store.record({ app: "api", checkedAt: NOW + 1_000, state: "down" }, NOW + 1_000);
    const snapshot = store.snapshot("api", NOW + 2_000);
    assert.equal(snapshot.current.state, "down");
    assert.equal(snapshot.recent.length, 1);
    assert.equal(snapshot.summary.downMs, 1_000);
    assert.equal(snapshot.summary.upMs, 0);
    assert.equal(snapshot.days.length, 14);
    assert.equal(store.snapshot("api", NOW + PROBE_INTERVAL_MS + 1_000).current.state, "unknown");
    assert.throws(() => store.snapshot("other", NOW), /declared app/);
    assert.throws(() => store.snapshot("api", NaN), /valid timestamp/);
    assert.throws(() => {
      store.record({ app: "other", checkedAt: NOW, state: "up" }, NOW);
    }, /declared app/);
    assert.throws(() => {
      store.record({ app: "api", checkedAt: NOW, state: "up" }, NOW + 1);
    }, /current observation/);
    assert.throws(() => {
      store.record({ app: "api", checkedAt: -1, state: "up" }, -1);
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("retention prunes on reopen and write, removes undeclared apps, and bounds recent reads", () => {
  const directory = mkdtempSync(join(tmpdir(), "deploy-retention-"));
  const path = join(directory, "history.sqlite");
  let store = openHealthHistoryStore(path, ["api", "removed"], NOW);
  try {
    store.record({ app: "removed", checkedAt: NOW, state: "down" }, NOW);
    store.record({ app: "api", checkedAt: NOW, state: "up" }, NOW);
    const future = NOW + HISTORY_RETENTION_MS + 2 * PROBE_INTERVAL_MS;
    store.close();
    store = openHealthHistoryStore(path, ["api"], future);
    assert.equal(store.snapshot("api", future).recent.length, 0);
    const check = new Database(path);
    assert.deepEqual(check.prepare("SELECT * FROM health_probes").all(), []);
    check.close();
    for (let index = 0; index < 70; index += 1) {
      const checkedAt = future + index * PROBE_INTERVAL_MS;
      store.record({ app: "api", checkedAt, state: "up" }, checkedAt);
    }
    assert.equal(store.snapshot("api", future + 70 * PROBE_INTERVAL_MS).recent.length, 60);
    const later = future + 2 * HISTORY_RETENTION_MS;
    store.record({ app: "api", checkedAt: later, state: "up" }, later);
    assert.equal(store.snapshot("api", later).recent.length, 1);
    const midnight = Math.ceil(later / DAY_MS) * DAY_MS;
    const days = store.snapshot("api", midnight).days;
    assert.equal(days.length, 14);
    assert.equal(days.at(-1)?.coveragePercent, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("a boundary predecessor contributes only its overlapping minute", () => {
  const store = openHealthHistoryStore(":memory:", ["api"], NOW);
  try {
    store.record({ app: "api", checkedAt: NOW, state: "up" }, NOW);
    const summary = store.snapshot("api", NOW + HISTORY_RETENTION_MS + 30_000).summary;
    assert.equal(summary.upMs, 30_000);
    assert.equal(summary.downMs, 0);
    assert.equal(summary.uptimePercent, 100);
    assert.ok(summary.coveragePercent < 0.01);
  } finally {
    store.close();
  }
});

void test("unsupported schema versions fail closed and release the file", () => {
  const directory = mkdtempSync(join(tmpdir(), "deploy-schema-"));
  const path = join(directory, "history.sqlite");
  try {
    const db = new Database(path);
    db.pragma("user_version = 2");
    db.close();
    assert.throws(() => openHealthHistoryStore(path, ["api"]), /Unsupported/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("UTC daily summaries split an observation at midnight", () => {
  const midnight = Math.ceil(NOW / DAY_MS) * DAY_MS;
  const store = openHealthHistoryStore(":memory:", ["api"], midnight);
  try {
    store.record({ app: "api", checkedAt: midnight - 30_000, state: "up" }, midnight - 30_000);
    const days = store.snapshot("api", midnight + 30_000).days;
    assert.equal(days.at(-2)?.upMs, 30_000);
    assert.equal(days.at(-1)?.upMs, 30_000);
    assert.equal(days.at(-1)?.coveragePercent, 100);
    assert.ok(days.at(-2)!.coveragePercent < 1);
  } finally {
    store.close();
  }
});
