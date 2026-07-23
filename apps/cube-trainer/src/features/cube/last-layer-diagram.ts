import type { AlgorithmSetId } from "@/features/algorithms/types";

import { extractLastLayer } from "./model";
import type { FaceLetter, FaceletCube } from "./model";

export type DiagramSticker = { kind: "oriented" } | { kind: "unknown" } | { kind: "color"; face: FaceLetter };

export interface LastLayerDiagram {
  top: DiagramSticker[];
  sides: {
    front: DiagramSticker[];
    right: DiagramSticker[];
    back: DiagramSticker[];
    left: DiagramSticker[];
  };
}

const ORIENTED: DiagramSticker = { kind: "oriented" };
const UNKNOWN: DiagramSticker = { kind: "unknown" };

function orientedOrUnknown(facelet: FaceLetter): DiagramSticker {
  return facelet === "U" ? ORIENTED : UNKNOWN;
}

function colorSticker(facelet: FaceLetter): DiagramSticker {
  return { face: facelet, kind: "color" };
}

/**
 * `extractLastLayer`'s side rows are each 3 facelets in that face's own row-major order
 * (documented on `FaceletCube`), which doesn't match how the row should be drawn next to
 * the top-face square: front/left already read left-to-right/top-to-bottom in drawing
 * order, but back and right are backwards (B's own col 0 touches R, not L; R's own col 0
 * touches F, not B) - matching the model's documented U-face convention (col 0 = left,
 * touching L; row 0 = back).
 */
function toDrawingOrder(row: FaceLetter[], reversed: boolean): FaceLetter[] {
  // `row` is always the fixed 3-facelet slice `extractLastLayer` returns for one side.
  const [a, b, c] = row as [FaceLetter, FaceLetter, FaceLetter];
  return reversed ? [c, b, a] : [a, b, c];
}

function buildDiagram(cube: FaceletCube, sideSticker: (facelet: FaceLetter) => DiagramSticker): LastLayerDiagram {
  const { sideRows, top } = extractLastLayer(cube);

  return {
    sides: {
      back: toDrawingOrder(sideRows.back, true).map(sideSticker),
      front: toDrawingOrder(sideRows.front, false).map(sideSticker),
      left: toDrawingOrder(sideRows.left, false).map(sideSticker),
      right: toDrawingOrder(sideRows.right, true).map(sideSticker),
    },
    top: top.map(orientedOrUnknown),
  };
}

/** OLL only guarantees orientation - side stickers show whether they're oriented (peeking the top color), never their actual color. */
export function deriveOllDiagram(cube: FaceletCube): LastLayerDiagram {
  return buildDiagram(cube, orientedOrUnknown);
}

/** PLL never touches orientation (top is read the same way and will naturally show fully oriented) - side stickers show their actual color, since permutation is what a PLL diagram communicates. */
export function derivePllDiagram(cube: FaceletCube): LastLayerDiagram {
  return buildDiagram(cube, colorSticker);
}

/** Picks the OLL- or PLL-appropriate derivation for a given set, so callers don't hand-roll the ternary. */
export function deriveDiagramForSet(setId: AlgorithmSetId, cube: FaceletCube): LastLayerDiagram {
  return setId === "oll" ? deriveOllDiagram(cube) : derivePllDiagram(cube);
}

export const DIAGRAM_PALETTE: Record<FaceLetter, string> = {
  B: "#3b82f6",
  D: "#f8fafc",
  F: "#22c55e",
  L: "#f97316",
  R: "#ef4444",
  U: "#eab308",
};

export const DIAGRAM_UNKNOWN_COLOR = "#52525b";

export function diagramStickerColor(sticker: DiagramSticker): string {
  if (sticker.kind === "unknown") return DIAGRAM_UNKNOWN_COLOR;
  if (sticker.kind === "oriented") return DIAGRAM_PALETTE.U;
  return DIAGRAM_PALETTE[sticker.face];
}
