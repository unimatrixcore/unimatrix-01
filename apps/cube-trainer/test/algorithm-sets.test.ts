import { describe, expect, it } from "vitest";

import { ALGORITHM_SETS, groupCasesByGroup } from "@/features/algorithms/algorithm-sets";

describe("algorithm sets", () => {
  it("has all 57 OLL cases with unique ids", () => {
    const { cases } = ALGORITHM_SETS.oll;

    expect(cases).toHaveLength(57);
    expect(new Set(cases.map((c) => c.id)).size).toBe(57);
  });

  it("has all 21 PLL cases with unique ids", () => {
    const { cases } = ALGORITHM_SETS.pll;

    expect(cases).toHaveLength(21);
    expect(new Set(cases.map((c) => c.id)).size).toBe(21);
  });

  it("gives every case at least one non-empty algorithm", () => {
    for (const set of Object.values(ALGORITHM_SETS)) {
      for (const algorithmCase of set.cases) {
        expect(algorithmCase.algorithms.length).toBeGreaterThan(0);

        for (const algorithm of algorithmCase.algorithms) {
          expect(algorithm.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("assigns every case to a group declared in groupOrder", () => {
    for (const set of Object.values(ALGORITHM_SETS)) {
      const knownGroups = new Set(set.groupOrder);

      for (const algorithmCase of set.cases) {
        expect(knownGroups.has(algorithmCase.group)).toBe(true);
      }
    }
  });

  it("groups cases without dropping or duplicating any case", () => {
    for (const set of Object.values(ALGORITHM_SETS)) {
      const grouped = groupCasesByGroup(set);
      const groupedIds = grouped.flatMap(({ cases }) => cases.map((c) => c.id));

      expect(groupedIds.sort()).toEqual(set.cases.map((c) => c.id).sort());
    }
  });
});
