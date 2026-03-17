import { describe, expect, it } from "vitest";

import {
  findEntryBySlug,
  indexEntriesBySlug,
} from "../src/features/content/lookups.js";

describe("content lookup helpers", () => {
  it("resolves authored entries by slug", () => {
    const entries = [
      { slug: "berrybot", title: "BerryBot" },
      { slug: "unimatrix-01", title: "Unimatrix-01" },
    ];

    expect(findEntryBySlug(entries, "berrybot")?.title).toBe("BerryBot");
    expect(indexEntriesBySlug(entries).get("unimatrix-01")?.title).toBe(
      "Unimatrix-01",
    );
  });

  it("returns undefined for missing slugs", () => {
    const entries = [{ slug: "berrybot" }, { slug: "typed-baseline" }];

    expect(findEntryBySlug(entries, "missing")).toBeUndefined();
  });

  it("throws when duplicate slugs are present", () => {
    expect(() =>
      indexEntriesBySlug([
        { slug: "duplicate", title: "First" },
        { slug: "duplicate", title: "Second" },
      ]),
    ).toThrow(/Duplicate content slug detected: duplicate/u);
  });
});
