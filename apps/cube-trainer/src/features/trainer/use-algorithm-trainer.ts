import { useCallback, useMemo, useState } from "react";

import { useCaseProgress } from "@/features/algorithms/use-case-progress";
import type { AlgorithmCase, AlgorithmSetId } from "@/features/algorithms/types";
import { getCaseSetup } from "@/features/trainer/case-setup";
import { pickNextCase } from "@/features/trainer/pick-next-case";
import { deriveOllDiagram, derivePllDiagram } from "@/features/cube/last-layer-diagram";
import type { LastLayerDiagram } from "@/features/cube/last-layer-diagram";
import type { CaseProgress, CaseStatus } from "@/lib/progress-storage";

export interface AlgorithmTrainerState {
  currentCase: AlgorithmCase | undefined;
  diagram: LastLayerDiagram | undefined;
  isRevealed: boolean;
  progress: CaseProgress;
  setupMoves: string | undefined;
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
    pickNextCase(cases, progress, undefined),
  );
  const [isRevealed, setIsRevealed] = useState(false);
  const [sessionCount, setSessionCount] = useState(0);

  const setup = useMemo(() => (currentCase ? getCaseSetup(currentCase) : undefined), [currentCase]);
  const diagram = useMemo(() => {
    if (!setup) return undefined;
    return setId === "oll" ? deriveOllDiagram(setup.cube) : derivePllDiagram(setup.cube);
  }, [setId, setup]);

  const advance = useCallback(
    (nextProgress: CaseProgress) => {
      setCurrentCase((previous) => pickNextCase(cases, nextProgress, previous?.id));
      setIsRevealed(false);
      setSessionCount((count) => count + 1);
    },
    [cases],
  );

  const reveal = useCallback(() => {
    setIsRevealed(true);
  }, []);

  const markStatus = useCallback(
    (status: CaseStatus) => {
      if (!currentCase) {
        return;
      }

      updateStatus(currentCase.id, status);
      // Use the just-computed progress directly rather than the hook's
      // `progress` value, which won't reflect this update until re-render.
      advance({ ...progress, [currentCase.id]: status });
    },
    [advance, currentCase, progress, updateStatus],
  );

  const skip = useCallback(() => {
    advance(progress);
  }, [advance, progress]);

  return useMemo(
    () => ({
      currentCase,
      diagram,
      isRevealed,
      markStatus,
      progress,
      reveal,
      sessionCount,
      setupMoves: setup?.setupMoves,
      skip,
    }),
    [currentCase, diagram, isRevealed, markStatus, progress, reveal, sessionCount, setup, skip],
  );
}
