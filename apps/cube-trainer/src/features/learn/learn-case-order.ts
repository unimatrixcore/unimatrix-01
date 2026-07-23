import type { AlgorithmCase, CaseGroup } from "@/features/algorithms/types";
import type { CaseProgress } from "@/lib/progress-storage";

/**
 * Deterministic (not random) teaching order: walk groups in curriculum order, within a
 * group teach the most common case first (descending probabilityWeight), skipping
 * anything already marked learned. This is the list Next/Back browse through, and the
 * one "Mark learned" removes the current case from.
 */
export function orderedLearnCases(
  groupedCases: CaseGroup[],
  progress: CaseProgress,
): AlgorithmCase[] {
  const result: AlgorithmCase[] = [];

  for (const { cases } of groupedCases) {
    const eligible = cases
      .filter((c) => progress[c.id] !== "known")
      .sort((a, b) => b.probabilityWeight - a.probabilityWeight);

    result.push(...eligible);
  }

  return result;
}
