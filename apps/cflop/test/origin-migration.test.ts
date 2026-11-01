import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMigrationUrl, handleOriginMigration, importMigration } from "@/lib/origin-migration";

const oldLocation = new URL("https://cube.unimatrix-01.dev/learn?set=pll#case");

function fragment(entries: unknown): string {
  return "#cflop-migrate=" + encodeURIComponent(JSON.stringify({ version: 1, hash: "", entries }));
}

describe("browser origin migration", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("transfers all storage families, preferring current keys, and preserves the destination", () => {
    localStorage.setItem("cube-trainer:progress:oll", '{"oll-1":"known"}');
    localStorage.setItem("cflop:progress:oll", '{"oll-2":"learning"}');
    localStorage.setItem("cflop:pool:pll", '{"pll-ua":false}');
    localStorage.setItem("cflop:pool-mode:pll", "only-learned");
    localStorage.setItem("cflop:preview-mode:drill", "hidden");
    localStorage.setItem("cflop:algorithm-set", "pll");
    localStorage.setItem("unrelated-secret", "do not transfer");
    const target = new URL(createMigrationUrl(oldLocation, localStorage));
    expect(target.origin + target.pathname + target.search).toBe("https://cflop.us/learn?set=pll");
    expect(decodeURIComponent(target.hash)).not.toContain("unrelated-secret");
    expect(localStorage.getItem("cube-trainer:progress:oll")).not.toBeNull();
    localStorage.clear();
    expect(importMigration(target.hash, localStorage)).toBe("imported");
    expect(localStorage.getItem("cflop:progress:oll")).toBe('{"oll-2":"learning"}');
    expect(localStorage.getItem("cflop:pool:pll")).toBe('{"pll-ua":false}');
    expect(localStorage.getItem("cflop:pool-mode:pll")).toBe("only-learned");
    expect(localStorage.getItem("cflop:preview-mode:drill")).toBe("hidden");
    expect(localStorage.getItem("cflop:algorithm-set")).toBe("pll");
  });

  it.each(["cflop:preview-mode:learn", "cube-trainer:progress:oll"])(
    "never imports anything if destination contains %s, even if malformed",
    (key) => {
      localStorage.setItem(key, "malformed-but-existing");
      expect(
        importMigration(fragment([["progress:pll", '{"pll-ua":"known"}']]), localStorage),
      ).toBe("existing");
      expect(localStorage.getItem("cflop:progress:pll")).toBeNull();
      expect(localStorage.getItem(key)).toBe("malformed-but-existing");
    },
  );

  it.each(
    [
      [["unrelated-secret", "injected"]],
      [["progress:oll", '{"oll-1":"injected"}']],
      [["pool:pll", '{"pll-ua":"false"}']],
      [["preview-mode:drill", "unknown"]],
      [["progress:oll", "not json"]],
      [
        ["algorithm-set", "pll"],
        ["algorithm-set", "oll"],
      ],
    ].map((entries) => ({ entries })),
  )("rejects malformed payloads without partial writes: %j", ({ entries }) => {
    expect(importMigration(fragment(entries), localStorage)).toBe("invalid");
    expect(localStorage.length).toBe(0);
  });

  it("rejects invalid encoding and oversized payloads", () => {
    expect(importMigration("#cflop-migrate=%xx", localStorage)).toBe("invalid");
    expect(importMigration("#cflop-migrate=" + "x".repeat(33_000), localStorage)).toBe("invalid");
  });

  it("ignores corrupt source data without deleting it", () => {
    localStorage.setItem("cflop:progress:oll", "broken");
    localStorage.setItem("cube-trainer:progress:oll", '{"oll-1":"known"}');
    expect(createMigrationUrl(oldLocation, localStorage)).toBe(
      "https://cflop.us/learn?set=pll#case",
    );
    expect(localStorage.getItem("cflop:progress:oll")).toBe("broken");
  });

  it("cannot redirect to another origin through a double-slash path", () => {
    const target = new URL(
      createMigrationUrl(new URL("https://cube.unimatrix-01.dev//evil.test/x"), localStorage),
    );
    expect(target.origin).toBe("https://cflop.us");
    expect(target.pathname).toBe("//evil.test/x");
  });

  it("rolls back a partial import if storage runs out of space", () => {
    const original = Storage.prototype.setItem.bind(localStorage);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "cflop:algorithm-set")
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      original(key, value);
    });
    expect(() =>
      importMigration(
        fragment([
          ["progress:oll", '{"oll-1":"known"}'],
          ["algorithm-set", "pll"],
        ]),
        localStorage,
      ),
    ).toThrow();
    expect(localStorage.length).toBe(0);
  });

  it("refuses an unimportable source fragment before navigating away", () => {
    localStorage.setItem("cflop:progress:oll", '{"oll-1":"known"}');
    const location = new URL(oldLocation);
    location.hash = "x".repeat(2049);
    expect(() => createMigrationUrl(location, localStorage)).toThrow();
    expect(localStorage.getItem("cflop:progress:oll")).toBe('{"oll-1":"known"}');
  });

  it("keeps destination cleanup on the same origin for double-slash paths", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "https://cflop.us//evil.test/path" + fragment([]) },
      localStorage,
      history: { state: null, replaceState },
    });
    try {
      expect(handleOriginMigration(document.createElement("div"))).toBe(false);
      expect(replaceState).toHaveBeenCalledWith(null, "", "https://cflop.us//evil.test/path");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does nothing on local development origins", () => {
    expect(handleOriginMigration(document.createElement("div"))).toBe(false);
  });
});
