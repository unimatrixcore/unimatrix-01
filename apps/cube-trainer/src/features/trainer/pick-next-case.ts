import type { AlgorithmCase } from "@/features/algorithms/types";

export function pickNextCase(
  cases: AlgorithmCase[],
  excludeId: string | undefined,
): AlgorithmCase | undefined {
  const candidates = cases.length > 1 ? cases.filter((c) => c.id !== excludeId) : cases;

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
