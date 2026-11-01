import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDokployCreationStore } from "../src/dokploy/creation-store.js";

void test("creation reservations survive restart and permit distinct apps", () => {
  const directory = mkdtempSync(join(tmpdir(), "dokploy-creation-"));
  const path = join(directory, "nested", "deploy.sqlite");
  let store = openDokployCreationStore(path);
  try {
    assert.equal(store.reserve("api"), true);
    assert.equal(store.reserve("api"), false);
    store.close();
    store = openDokployCreationStore(path);
    assert.equal(store.reserve("api"), false);
    assert.equal(store.reserve("web"), true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("competing connections cannot reserve the same app", () => {
  const directory = mkdtempSync(join(tmpdir(), "dokploy-creation-competing-"));
  const path = join(directory, "deploy.sqlite");
  const first = openDokployCreationStore(path);
  const second = openDokployCreationStore(path);
  try {
    assert.equal(first.reserve("api"), true);
    assert.equal(second.reserve("api"), false);
    assert.equal(second.reserve("web"), true);
    assert.equal(first.reserve("web"), false);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("in-memory reservations work and a closed store refuses writes", () => {
  const store = openDokployCreationStore(":memory:");
  assert.equal(store.reserve("api"), true);
  assert.equal(store.reserve("api"), false);
  store.close();
  assert.throws(() => store.reserve("web"), /database connection is not open/u);
});
