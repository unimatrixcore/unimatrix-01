import { describe, expect, it } from "vitest";

import type { AlgorithmCase } from "@/features/algorithms/types";
import { orderedLearnCases } from "@/features/learn/learn-case-order";
import type { CaseProgress } from "@/lib/progress-storage";

function makeCase(id: string, group: string, probabilityWeight = 1): AlgorithmCase {
  return { algorithms: ["R U R' U'"], displayName: id, group, id, probabilityWeight };
}

describe("orderedLearnCases", () => {
  it("orders by group first, regardless of weight", () => {
    const groupedCases = [
      { cases: [makeCase("a", "Group A", 1)], group: "Group A" },
      { cases: [makeCase("b", "Group B", 10)], group: "Group B" },
    ];

    expect(orderedLearnCases(groupedCases, {}).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("orders cases within a group by descending probabilityWeight", () => {
    const groupedCases = [
      {
        cases: [makeCase("low", "Group A", 1), makeCase("high", "Group A", 5)],
        group: "Group A",
      },
    ];

    expect(orderedLearnCases(groupedCases, {}).map((c) => c.id)).toEqual(["high", "low"]);
  });

  it("skips known (learned) cases", () => {
    const groupedCases = [
      { cases: [makeCase("a", "Group A"), makeCase("b", "Group A")], group: "Group A" },
    ];
    const progress: CaseProgress = { a: "known" };

    expect(orderedLearnCases(groupedCases, progress).map((c) => c.id)).toEqual(["b"]);
  });

  it("returns an empty list once every case is known", () => {
    const groupedCases = [{ cases: [makeCase("a", "Group A")], group: "Group A" }];
    const progress: CaseProgress = { a: "known" };

    expect(orderedLearnCases(groupedCases, progress)).toEqual([]);
  });
});
