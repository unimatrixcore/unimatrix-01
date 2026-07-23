import { describe, expect, it } from "vitest";

import { applyMoves } from "@/features/cube/engine";
import {
  deriveOllDiagram,
  derivePllDiagram,
  diagramStickerColor,
} from "@/features/cube/last-layer-diagram";
import { createSolvedCube } from "@/features/cube/model";
import { parseAlgorithm } from "@/features/cube/notation";

describe("deriveOllDiagram", () => {
  it("shows a fully oriented top and no side stickers peeking U for a solved cube", () => {
    // "Oriented" means "this facelet is the piece's U-sticker" - on a genuinely solved
    // cube the U-sticker is never on a side, so the side tabs are all gray, not yellow.
    const diagram = deriveOllDiagram(createSolvedCube());

    expect(diagram.top.every((s) => s.kind === "oriented")).toBe(true);
    for (const side of Object.values(diagram.sides)) {
      expect(side.every((s) => s.kind === "unknown")).toBe(true);
    }
  });

  it("shows unknown (gray) side/edge stickers for an unsolved OLL case", () => {
    // Sune, applied once to a solved cube, leaves a well-known partially-oriented OLL case.
    const cube = applyMoves(createSolvedCube(), parseAlgorithm("R U R' U R U2 R'"));
    const diagram = deriveOllDiagram(cube);

    expect(diagram.top.some((s) => s.kind === "unknown")).toBe(true);
  });
});

describe("derivePllDiagram", () => {
  it("shows a fully oriented top and real side colors for a solved cube", () => {
    const diagram = derivePllDiagram(createSolvedCube());

    expect(diagram.top.every((s) => s.kind === "oriented")).toBe(true);
    expect(diagram.sides.front.every((s) => s.kind === "color" && s.face === "F")).toBe(true);
    expect(diagram.sides.right.every((s) => s.kind === "color" && s.face === "R")).toBe(true);
    expect(diagram.sides.back.every((s) => s.kind === "color" && s.face === "B")).toBe(true);
    expect(diagram.sides.left.every((s) => s.kind === "color" && s.face === "L")).toBe(true);
  });

  it("shows mixed side colors for an unsolved PLL case (H perm)", () => {
    const cube = applyMoves(createSolvedCube(), parseAlgorithm("M2 U M2 U2 M2 U M2"));
    const diagram = derivePllDiagram(cube);
    const frontColors = new Set(diagram.sides.front.map((s) => (s.kind === "color" ? s.face : null)));

    expect(frontColors.size).toBeGreaterThan(1);
  });
});

describe("diagramStickerColor", () => {
  it("gives distinct colors for oriented, unknown, and each face", () => {
    const colors = new Set([
      diagramStickerColor({ kind: "oriented" }),
      diagramStickerColor({ kind: "unknown" }),
      diagramStickerColor({ face: "F", kind: "color" }),
      diagramStickerColor({ face: "R", kind: "color" }),
      diagramStickerColor({ face: "B", kind: "color" }),
      diagramStickerColor({ face: "L", kind: "color" }),
    ]);

    expect(colors.size).toBe(6);
  });
});
