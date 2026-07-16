import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

describe("site content registry", () => {
  it("registers every authored project and blog file", () => {
    const siteContentSource = readFileSync(
      join(process.cwd(), "src", "features", "content", "site-content.ts"),
      "utf8",
    );

    expect(siteContentSource).toMatch(/content\/home\/index\.md/u);
    expect(getRegisteredCollectionFilePaths("projects")).toEqual(
      getAuthoredCollectionFilePaths("projects"),
    );
    expect(getRegisteredCollectionFilePaths("blog")).toEqual(
      getAuthoredCollectionFilePaths("blog"),
    );
  });

  it("renders authored copy directly without runtime text normalization", () => {
    const siteContentSource = readFileSync(
      join(process.cwd(), "src", "features", "content", "site-content.ts"),
      "utf8",
    );

    expect(siteContentSource).not.toMatch(/normalizePortfolioCopy/u);
    expect(siteContentSource).not.toMatch(/features\/public-site\/copy/u);
  });
});
