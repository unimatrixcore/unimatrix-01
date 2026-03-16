import assert from "node:assert/strict";
import test from "node:test";

import {
  findBlogEntryBySlug,
  findEntryBySlug,
  findProjectEntryBySlug,
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

void test("project and blog lookup helpers return undefined for missing slugs", () => {
  const projects = [{ slug: "berrybot" }] as Parameters<typeof findProjectEntryBySlug>[0];
  const blogEntries = [{ slug: "typed-baseline" }] as Parameters<typeof findBlogEntryBySlug>[0];

  assert.equal(findProjectEntryBySlug(projects, "missing"), undefined);
  assert.equal(findBlogEntryBySlug(blogEntries, "missing"), undefined);
});