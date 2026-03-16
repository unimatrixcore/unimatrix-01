import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function getRepoRootDirectory(): string {
  return join(process.cwd(), "..", "..");
}

function getAuthoredCollectionFilePaths(collectionDirectory: string): string[] {
  return readdirSync(join(getRepoRootDirectory(), "content", collectionDirectory))
    .filter((entryName) => entryName.endsWith(".md") && !entryName.startsWith("_"))
    .map((entryName) => `content/${collectionDirectory}/${entryName}`)
    .sort();
}

function getRegisteredCollectionFilePaths(collectionDirectory: "blog" | "projects"): string[] {
  const siteContentSource = readFileSync(
    join(process.cwd(), "src", "features", "content", "site-content.ts"),
    "utf8",
  );
  const filePathPattern = new RegExp(`content/${collectionDirectory}/[^/"'\\s]+\\.md`, "gu");

  return [...new Set(siteContentSource.match(filePathPattern) ?? [])].sort();
}

void test("site-content registers every authored project and blog file", () => {
  const siteContentSource = readFileSync(
    join(process.cwd(), "src", "features", "content", "site-content.ts"),
    "utf8",
  );

  assert.match(siteContentSource, /content\/home\/index\.md/u);
  assert.deepEqual(
    getRegisteredCollectionFilePaths("projects"),
    getAuthoredCollectionFilePaths("projects"),
  );
  assert.deepEqual(
    getRegisteredCollectionFilePaths("blog"),
    getAuthoredCollectionFilePaths("blog"),
  );
});
