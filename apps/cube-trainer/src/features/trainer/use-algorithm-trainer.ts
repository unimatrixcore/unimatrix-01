import { useCallback, useMemo, useState } from "react";

import { deriveDiagramForSet } from "@/features/algorithms/derive-diagram";
import type { AlgorithmCase, AlgorithmSetId } from "@/features/algorithms/types";
import { useCasePool } from "@/features/algorithms/use-case-pool";
import type { LastLayerDiagram } from "@/features/cube/last-layer-diagram";
import { getCaseSetup } from "@/features/trainer/case-setup";
import { pickNextCase } from "@/features/trainer/pick-next-case";

export interface AlgorithmTrainerState {
  currentCase: AlgorithmCase | undefined;
  diagram: LastLayerDiagram | undefined;
  setupMoves: string | undefined;
  next: () => void;
}

export function useAlgorithmTrainer(
  setId: AlgorithmSetId,
  cases: AlgorithmCase[],
): AlgorithmTrainerState {
  const { pool } = useCasePool(setId);
  const [currentCase, setCurrentCase] = useState<AlgorithmCase | undefined>(() =>
    pickNextCase(cases, pool, undefined),
  );

  const setup = useMemo(() => (currentCase ? getCaseSetup(currentCase) : undefined), [currentCase]);
  const diagram = useMemo(() => {
    if (!setup) return undefined;
    return deriveDiagramForSet(setId, setup.cube);
  }, [setId, setup]);

  const next = useCallback(() => {
    setCurrentCase((previous) => pickNextCase(cases, pool, previous?.id));
  }, [cases, pool]);

  return useMemo(
    () => ({
      currentCase,
      diagram,
      next,
      setupMoves: setup?.setupMoves,
    }),
    [currentCase, diagram, next, setup],
  );
}
