import assert from "node:assert/strict";
import test from "node:test";

import {
  findEntryBySlug,
  indexEntriesBySlug,
} from "../src/features/content/lookups.js";

void test("content lookup helpers resolve authored entries by slug", () => {
  const entries = [
    { slug: "berrybot", title: "BerryBot" },
    { slug: "unimatrix-01", title: "Unimatrix-01" },
  ];

  assert.equal(findEntryBySlug(entries, "berrybot")?.title, "BerryBot");
  assert.equal(indexEntriesBySlug(entries).get("unimatrix-01")?.title, "Unimatrix-01");
});

void test("findEntryBySlug returns undefined for missing slugs", () => {
  const entries = [{ slug: "berrybot" }, { slug: "typed-baseline" }];

  assert.equal(findEntryBySlug(entries, "missing"), undefined);
});

void test("indexEntriesBySlug throws when duplicate slugs are present", () => {
  assert.throws(
    () =>
      indexEntriesBySlug([
        { slug: "duplicate", title: "First" },
        { slug: "duplicate", title: "Second" },
      ]),
    /Duplicate content slug detected: duplicate/u,
  );
});
