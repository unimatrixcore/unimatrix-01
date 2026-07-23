import { describe, expect, it } from "vitest";

import type { AlgorithmCase } from "@/features/algorithms/types";
import { applyMoves } from "@/features/cube/engine";
import { createSolvedCube, extractLastLayer } from "@/features/cube/model";
import type { FaceletCube } from "@/features/cube/model";
import { parseAlgorithm } from "@/features/cube/notation";
import { getCaseSetup } from "@/features/trainer/case-setup";

function makeCase(id: string, algorithm: string): AlgorithmCase {
  return { algorithms: [algorithm], displayName: id, group: "Test", id, probabilityWeight: 1 };
}

// All of D, plus rows 1-2 (not row 0, which belongs to the last layer) of R/F/L/B.
function bottomTwoLayersDiffCount(cube: FaceletCube): number {
  const solved = createSolvedCube();
  let diffs = 0;
  for (let i = 27; i < 36; i++) if (cube[i] !== solved[i]) diffs++;
  for (const faceStart of [9, 18, 36, 45]) {
    for (let i = faceStart + 3; i < faceStart + 9; i++) {
      if (cube[i] !== solved[i]) diffs++;
    }
  }
  return diffs;
}

describe("getCaseSetup - PLL cases carrying a net whole-cube rotation", () => {
  // Aa/Ja/E all lead with a bare x/x' rotation before their solving moves - a case where
  // undoing the rotation *after* inverting the algorithm (rather than pre-rotating before
  // inverting) previously produced a state with a corner cycled between the last layer and
  // the bottom two layers, which is impossible for a genuine PLL algorithm.
  const rotationCarryingCases = [
    ["Aa", "x L2 D2 L' U' L D2 L' U L'"],
    ["Ja", "x R2 F R F' R U2 r' U r U2"],
    ["E", "x' L' U L D' L' U' L D L' U' L D' L' U L D"],
  ] as const;

  it.each(rotationCarryingCases)(
    "%s: last layer is fully oriented and the bottom two layers are untouched",
    (name, algorithm) => {
      const setup = getCaseSetup(makeCase(name, algorithm));
      expect(extractLastLayer(setup.cube).top.every((f) => f === "U")).toBe(true);
      expect(bottomTwoLayersDiffCount(setup.cube)).toBe(0);
    },
  );

  it("a rotation-free case (Ua) is unaffected by the pre-rotation logic", () => {
    const setup = getCaseSetup(makeCase("Ua", "M2 U' M U2 M' U' M2"));
    expect(extractLastLayer(setup.cube).top.every((f) => f === "U")).toBe(true);
    expect(bottomTwoLayersDiffCount(setup.cube)).toBe(0);
  });

  it("setupMoves reproduces the exact rendered cube when applied to a solved cube", () => {
    const setup = getCaseSetup(makeCase("Aa", "x L2 D2 L' U' L D2 L' U L'"));
    expect(applyMoves(createSolvedCube(), parseAlgorithm(setup.setupMoves))).toEqual(setup.cube);
  });
});
