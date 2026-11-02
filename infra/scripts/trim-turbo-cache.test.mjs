import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  mkdir,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { trimTurboCache } from "./trim-turbo-cache.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "trim-turbo-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function entry(root, hash, modifiedAt, bytesPerFile = 4) {
  const names = [`${hash}.tar.zst`, `${hash}-meta.json`, `${hash}-manifest.json`];
  for (const name of names) {
    const file = join(root, name);
    await writeFile(file, Buffer.alloc(bytesPerFile));
    await utimes(file, modifiedAt, modifiedAt);
  }
  return names;
}

test("retains the newest entries and removes each old archive with all metadata", async (t) => {
  const root = await fixture(t);
  await entry(root, "1111111111111111", 1);
  const middle = await entry(root, "2222222222222222", 2);
  const newest = await entry(root, "3333333333333333", 3);

  assert.deepEqual(await trimTurboCache(root, { maxBytes: 24 }), {
    maxBytes: 24,
    bytesBefore: 36,
    bytesAfter: 24,
    retainedEntries: 2,
    removedEntries: 1,
    ignoredEntries: 0,
  });
  assert.deepEqual((await readdir(root)).sort(), [...middle, ...newest].sort());
});

test("drops an oversized entry as a group while retaining smaller usable entries", async (t) => {
  const root = await fixture(t);
  const older = await entry(root, "1111111111111111", 1);
  await entry(root, "2222222222222222", 2, 20);

  const result = await trimTurboCache(root, { maxBytes: 12 });
  assert.equal(result.bytesAfter, 12);
  assert.equal(result.removedEntries, 1);
  assert.deepEqual((await readdir(root)).sort(), older.sort());
});

test("handles old cache pairs and orphaned metadata without leaving partial groups", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "1111111111111111.tar.zst"), "data");
  await writeFile(join(root, "1111111111111111-meta.json"), "data");
  await writeFile(join(root, "2222222222222222-manifest.json"), "data");

  const result = await trimTurboCache(root, { maxBytes: 0 });
  assert.equal(result.removedEntries, 2);
  assert.equal(result.bytesAfter, 0);
  assert.deepEqual(await readdir(root), []);
});

test("does not follow symlinks or touch unrelated files and directories", async (t) => {
  const root = await fixture(t);
  const cache = join(root, "cache");
  await mkdir(cache);
  const outside = join(root, "outside.txt");
  await writeFile(outside, "preserve");
  await symlink(outside, join(cache, "1111111111111111.tar.zst"));
  await writeFile(join(cache, "unrelated.json"), "preserve");
  await mkdir(join(cache, "2222222222222222-meta.json"));

  const result = await trimTurboCache(cache, { maxBytes: 0 });
  assert.equal(result.ignoredEntries, 3);
  assert.equal(result.removedEntries, 0);
  assert.equal(await readFile(outside, "utf8"), "preserve");
  assert.equal(await readFile(join(cache, "unrelated.json"), "utf8"), "preserve");
});

test("a missing cache is empty, and a negative or unsafe budget fails", async (t) => {
  const root = await fixture(t);
  const result = await trimTurboCache(join(root, "absent"));
  assert.equal(result.bytesAfter, 0);
  assert.equal(result.removedEntries, 0);
  for (const maxBytes of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(trimTurboCache(root, { maxBytes }), /non-negative safe integer/u);
  }
});
