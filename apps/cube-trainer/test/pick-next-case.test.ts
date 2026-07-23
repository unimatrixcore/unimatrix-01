import { describe, expect, it } from "vitest";

import type { AlgorithmCase } from "@/features/algorithms/types";
import { pickNextCase } from "@/features/trainer/pick-next-case";
import type { CasePool } from "@/lib/pool-storage";

function makeCase(id: string, probabilityWeight = 1): AlgorithmCase {
  return { algorithms: ["R U R' U'"], displayName: id, group: "Test", id, probabilityWeight };
}

describe("pickNextCase", () => {
  it("never returns a disabled case", () => {
    const cases = [makeCase("a"), makeCase("b"), makeCase("c")];
    const pool: CasePool = { a: false, b: false };

    for (let i = 0; i < 20; i++) {
      expect(pickNextCase(cases, pool, undefined)?.id).toBe("c");
    }
  });

  it("returns undefined when every case is disabled", () => {
    const cases = [makeCase("a"), makeCase("b")];
    const pool: CasePool = { a: false, b: false };

    expect(pickNextCase(cases, pool, undefined)).toBeUndefined();
  });

  it("treats cases with no recorded pool entry as enabled", () => {
    const cases = [makeCase("a"), makeCase("b")];

    for (let i = 0; i < 20; i++) {
      expect(["a", "b"]).toContain(pickNextCase(cases, {}, undefined)?.id);
    }
  });

  it("avoids repeating the excluded case when other enabled candidates exist", () => {
    const cases = [makeCase("a"), makeCase("b")];

    for (let i = 0; i < 20; i++) {
      expect(pickNextCase(cases, {}, "a")?.id).toBe("b");
    }
  });

  it("allows repeating the excluded case when it is the only enabled candidate", () => {
    const cases = [makeCase("a"), makeCase("b")];
    const pool: CasePool = { b: false };

    expect(pickNextCase(cases, pool, "a")?.id).toBe("a");
  });

  it("returns undefined for an empty case list", () => {
    expect(pickNextCase([], {}, undefined)).toBeUndefined();
  });
});
