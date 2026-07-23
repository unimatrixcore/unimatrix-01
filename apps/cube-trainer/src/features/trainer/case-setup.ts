import type { AlgorithmCase } from "@/features/algorithms/types";
import { applyMoves, normalizeOrientation } from "@/features/cube/engine";
import { createSolvedCube } from "@/features/cube/model";
import type { FaceletCube } from "@/features/cube/model";
import { invertMoves, movesToString, parseAlgorithm } from "@/features/cube/notation";

export interface CaseSetup {
  cube: FaceletCube;
  setupMoves: string;
}

/**
 * Derives what a case actually looks like from its primary algorithm alone (no separate
 * per-case facelet data to keep in sync): invert the solving algorithm, apply it to a
 * solved cube, then normalize orientation so callers never see the last layer sitting on
 * the wrong physical face (some algorithms, mostly PLL, carry a net whole-cube rotation).
 */
export function getCaseSetup(algorithmCase: AlgorithmCase): CaseSetup {
  const primary = algorithmCase.algorithms[0];

  if (!primary) {
    return { cube: createSolvedCube(), setupMoves: "" };
  }

  const setupMoveList = invertMoves(parseAlgorithm(primary));

  return {
    cube: normalizeOrientation(applyMoves(createSolvedCube(), setupMoveList)),
    setupMoves: movesToString(setupMoveList),
  };
}
