import type { AlgorithmCase } from "@/features/algorithms/types";
import type { CaseProgress } from "@/lib/progress-storage";

export interface ProgressSummary {
  total: number;
  known: number;
  learning: number;
  new: number;
}

export function summarizeProgress(
  cases: AlgorithmCase[],
  progress: CaseProgress,
): ProgressSummary {
  let known = 0;
  let learning = 0;

  for (const algorithmCase of cases) {
    const status = progress[algorithmCase.id];

    if (status === "known") {
      known += 1;
    } else if (status === "learning") {
      learning += 1;
    }
  }

  return {
    known,
    learning,
    new: cases.length - known - learning,
    total: cases.length,
  };
}
