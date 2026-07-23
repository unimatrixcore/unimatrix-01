import { useCallback, useState } from "react";

import type { AlgorithmSetId } from "@/features/algorithms/types";
import { type CaseProgress, type CaseStatus, readCaseProgress, setCaseStatus } from "@/lib/progress-storage";

export interface UseCaseProgressResult {
  progress: CaseProgress;
  updateStatus: (caseId: string, status: CaseStatus) => void;
}

export function useCaseProgress(setId: AlgorithmSetId): UseCaseProgressResult {
  const [progress, setProgress] = useState<CaseProgress>(() => readCaseProgress(setId));

  const updateStatus = useCallback(
    (caseId: string, status: CaseStatus) => {
      setProgress(setCaseStatus(setId, caseId, status));
    },
    [setId],
  );

  return { progress, updateStatus };
}
