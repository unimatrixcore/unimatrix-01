import type { AlgorithmCase } from "@/features/algorithms/types";
import { applyMoves, netRotationFor } from "@/features/cube/engine";
import { createSolvedCube } from "@/features/cube/model";
import type { FaceletCube } from "@/features/cube/model";
import { invertMoves, movesToString, parseAlgorithm } from "@/features/cube/notation";

export interface CaseSetup {
  cube: FaceletCube;
  setupMoves: string;
}

/**
 * Derives what a case actually looks like from its primary algorithm alone (no separate
 * per-case facelet data to keep in sync). Some algorithms (mostly PLL - Aa, Ab, E, Ja, ...)
 * carry a net whole-cube rotation. That rotation must be applied to the solved cube
 * *before* inverting the algorithm, not corrected after the fact: the rotation doesn't
 * commute with the algorithm's other moves, so undoing it post-hoc on the already-inverted
 * state gives a different (wrong) permutation than pre-rotating and then inverting. Only
 * pre-rotating makes the two rotations cancel exactly. See `netRotationFor`'s doc comment.
 */
export function getCaseSetup(algorithmCase: AlgorithmCase): CaseSetup {
  const primary = algorithmCase.algorithms[0];

  if (!primary) {
    return { cube: createSolvedCube(), setupMoves: "" };
  }

  const primaryMoves = parseAlgorithm(primary);
  const netRotation = netRotationFor(primaryMoves);
  const setupMoveList = [...netRotation, ...invertMoves(primaryMoves)];

  return {
    cube: applyMoves(createSolvedCube(), setupMoveList),
    // Includes the net-rotation prefix (when there is one) so the displayed text actually
    // reproduces the rendered diagram - dropping it would show text that doesn't match.
    setupMoves: movesToString(setupMoveList),
  };
}
