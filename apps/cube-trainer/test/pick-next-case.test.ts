import { describe, expect, it } from "vitest";

import type { AlgorithmCase } from "@/features/algorithms/types";
import { pickNextCase } from "@/features/trainer/pick-next-case";
import type { CaseProgress } from "@/lib/progress-storage";

function makeCase(id: string, probabilityWeight = 1): AlgorithmCase {
  return { algorithms: ["R U R' U'"], displayName: id, group: "Test", id, probabilityWeight };
}

describe("pickNextCase", () => {
  it("never returns a case marked known", () => {
    const cases = [makeCase("a"), makeCase("b"), makeCase("c")];
    const progress: CaseProgress = { a: "known", b: "known" };

    for (let i = 0; i < 20; i++) {
      expect(pickNextCase(cases, progress, undefined)?.id).toBe("c");
    }
  });

  it("returns undefined when every case is known", () => {
    const cases = [makeCase("a"), makeCase("b")];
    const progress: CaseProgress = { a: "known", b: "known" };

    expect(pickNextCase(cases, progress, undefined)).toBeUndefined();
  });

  it("avoids repeating the excluded case when other unknown candidates exist", () => {
    const cases = [makeCase("a"), makeCase("b")];

    for (let i = 0; i < 20; i++) {
      expect(pickNextCase(cases, {}, "a")?.id).toBe("b");
    }
  });

  it("allows repeating the excluded case when it is the only unknown candidate", () => {
    const cases = [makeCase("a"), makeCase("b")];
    const progress: CaseProgress = { b: "known" };

    expect(pickNextCase(cases, progress, "a")?.id).toBe("a");
  });

  it("returns undefined for an empty case list", () => {
    expect(pickNextCase([], {}, undefined)).toBeUndefined();
  });
});
