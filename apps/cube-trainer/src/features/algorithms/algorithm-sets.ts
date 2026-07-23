import { OLL_ALGORITHMS } from "./oll-algorithms.data";
import { PLL_ALGORITHMS } from "./pll-algorithms.data";
import type { AlgorithmSet, AlgorithmSetId } from "./types";

const OLL_GROUP_ORDER = [
  "Dot",
  "Square Shape",
  "Small Lightning Bolt",
  "Fish Shape",
  "Knight Move Shape",
  "Cross",
  "Corners Oriented",
  "Awkward Shape",
  "P Shape",
  "T Shape",
  "C Shape",
  "W Shape",
  "Big Lightning Bolt",
  "Small L Shape",
  "I Shape",
];

const PLL_GROUP_ORDER = ["Edges Only", "Adjacent Corner Swap", "Diagonal Corner Swap"];

export const ALGORITHM_SETS: Record<AlgorithmSetId, AlgorithmSet> = {
  oll: {
    cases: OLL_ALGORITHMS,
    description:
      "Orient the last layer so every piece shows the top color, without disturbing its position.",
    groupOrder: OLL_GROUP_ORDER,
    id: "oll",
    label: "OLL",
  },
  pll: {
    cases: PLL_ALGORITHMS,
    description:
      "Permute the last layer's pieces into their solved positions to finish the cube.",
    groupOrder: PLL_GROUP_ORDER,
    id: "pll",
    label: "PLL",
  },
};

export function getAlgorithmSet(id: AlgorithmSetId): AlgorithmSet {
  return ALGORITHM_SETS[id];
}

export function groupCasesByGroup(
  set: AlgorithmSet,
): { group: string; cases: AlgorithmSet["cases"] }[] {
  return set.groupOrder.map((group) => ({
    cases: set.cases.filter((algorithmCase) => algorithmCase.group === group),
    group,
  }));
}
