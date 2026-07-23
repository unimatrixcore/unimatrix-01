import { useCallback, useMemo, useState } from "react";

import { useCaseProgress } from "@/features/algorithms/use-case-progress";
import type { AlgorithmCase, AlgorithmSetId } from "@/features/algorithms/types";
import { pickNextCase } from "@/features/trainer/pick-next-case";
import type { CaseProgress, CaseStatus } from "@/lib/progress-storage";

export interface AlgorithmTrainerState {
  currentCase: AlgorithmCase | undefined;
  isRevealed: boolean;
  progress: CaseProgress;
  sessionCount: number;
  reveal: () => void;
  markStatus: (status: CaseStatus) => void;
  skip: () => void;
}

export function useAlgorithmTrainer(
  setId: AlgorithmSetId,
  cases: AlgorithmCase[],
): AlgorithmTrainerState {
  const { progress, updateStatus } = useCaseProgress(setId);
  const [currentCase, setCurrentCase] = useState<AlgorithmCase | undefined>(() =>
    pickNextCase(cases, undefined),
  );
  const [isRevealed, setIsRevealed] = useState(false);
  const [sessionCount, setSessionCount] = useState(0);

  const advance = useCallback(() => {
    setCurrentCase((previous) => pickNextCase(cases, previous?.id));
    setIsRevealed(false);
    setSessionCount((count) => count + 1);
  }, [cases]);

  const reveal = useCallback(() => {
    setIsRevealed(true);
  }, []);

  const markStatus = useCallback(
    (status: CaseStatus) => {
      if (!currentCase) {
        return;
      }

      updateStatus(currentCase.id, status);
      advance();
    },
    [advance, currentCase, updateStatus],
  );

  const skip = useCallback(() => {
    advance();
  }, [advance]);

  return useMemo(
    () => ({
      currentCase,
      isRevealed,
      markStatus,
      progress,
      reveal,
      sessionCount,
      skip,
    }),
    [currentCase, isRevealed, markStatus, progress, reveal, sessionCount, skip],
  );
}
