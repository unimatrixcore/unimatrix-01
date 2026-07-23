import type { AlgorithmCase } from "@/features/algorithms/types";
import type { CasePool } from "@/lib/pool-storage";
import { isCaseEnabled } from "@/lib/pool-storage";

export function pickNextCase(
  cases: AlgorithmCase[],
  pool: CasePool,
  excludeId: string | undefined,
): AlgorithmCase | undefined {
  const enabled = cases.filter((c) => isCaseEnabled(pool, c.id));
  const candidates = enabled.length > 1 ? enabled.filter((c) => c.id !== excludeId) : enabled;

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
