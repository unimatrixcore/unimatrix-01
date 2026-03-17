import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { normalizeDatabaseFilePath } from "../src/config.js";

describe("database path normalization", () => {
  it("preserves the in-memory sentinel", () => {
    expect(normalizeDatabaseFilePath(":memory:")).toBe(":memory:");
  });

  it("normalizes file urls", () => {
    const fileUrl = new URL("../local/url-test.sqlite", import.meta.url);

    expect(normalizeDatabaseFilePath(fileUrl.href)).toBe(fileURLToPath(fileUrl));
  });

  it("preserves absolute paths", () => {
    const absolutePath = fileURLToPath(new URL("../local/absolute-test.sqlite", import.meta.url));

    expect(isAbsolute(absolutePath)).toBe(true);
    expect(normalizeDatabaseFilePath(absolutePath)).toBe(absolutePath);
  });

  it("resolves relative paths from the package root", () => {
    expect(normalizeDatabaseFilePath("local/relative-test.sqlite")).toBe(
      fileURLToPath(new URL("../local/relative-test.sqlite", import.meta.url)),
    );
  });
});
