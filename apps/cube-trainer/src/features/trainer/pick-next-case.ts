import type { AlgorithmCase } from "@/features/algorithms/types";
import type { CaseProgress } from "@/lib/progress-storage";

export function pickNextCase(
  cases: AlgorithmCase[],
  progress: CaseProgress,
  excludeId: string | undefined,
): AlgorithmCase | undefined {
  const unknown = cases.filter((c) => progress[c.id] !== "known");
  const candidates = unknown.length > 1 ? unknown.filter((c) => c.id !== excludeId) : unknown;

  if (candidates.length === 0) {
    return undefined;
  }

  const totalWeight = candidates.reduce((sum, c) => sum + c.probabilityWeight, 0);

  if (totalWeight <= 0) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  let roll = Math.random() * totalWeight;

  for (const algorithmCase of candidates) {
    roll -= algorithmCase.probabilityWeight;

    if (roll <= 0) {
      return algorithmCase;
    }
  }

  return candidates[candidates.length - 1];
}
