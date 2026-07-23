export type FaceLetter = "U" | "D" | "L" | "R" | "F" | "B";

/**
 * A 54-element facelet representation. Facelets are grouped into six 9-facelet blocks in
 * face order U, R, F, D, L, B (block k occupies indices [9k, 9k + 9)); within a block,
 * facelets are row-major (index = row * 3 + col, rows/cols 0-2) as seen by an observer
 * standing outside that face looking straight at it. Each face picks which edge is "row 0"
 * so the whole scheme matches a standard cube net:
 *   - U: row 0 touches B, row 2 touches F; col 0 touches L, col 2 touches R.
 *     (U[0] is therefore the sticker belonging to the U-B-L corner.)
 *   - F, R, B, L: row 0 touches U, row 2 touches D.
 *     - F: col 0 touches L, col 2 touches R.
 *     - R: col 0 touches F, col 2 touches B.
 *     - B: col 0 touches R, col 2 touches L.
 *     - L: col 0 touches B, col 2 touches F.
 *   - D: row 0 touches F, row 2 touches B; col 0 touches L, col 2 touches R.
 *
 * A facelet's *value* is the face letter it started on. Moves permute values between
 * positions but never change a value, so a "U" appearing outside the U block means that
 * originally-U sticker has moved elsewhere; this is how orientation/permutation are read.
 *
 * Raw indices are intentionally not exposed as public API - use `extractLastLayer` to read
 * cube state. `FACE_ORDER` and the row/col <-> xyz helpers below are exported only for
 * `engine.ts`'s internal move-application logic, which needs to agree with this scheme.
 */
export type FaceletCube = FaceLetter[];

export const FACE_ORDER: readonly FaceLetter[] = ["U", "R", "F", "D", "L", "B"];

export function createSolvedCube(): FaceletCube {
  const cube: FaceLetter[] = [];

  for (const face of FACE_ORDER) {
    for (let i = 0; i < 9; i += 1) {
      cube.push(face);
    }
  }

  return cube;
}

export interface LastLayerView {
  top: FaceLetter[];
  sideRows: {
    front: FaceLetter[];
    right: FaceLetter[];
    back: FaceLetter[];
    left: FaceLetter[];
  };
}

export function extractLastLayer(cube: FaceletCube): LastLayerView {
  const uStart = faceletIndex("U", 0, 0);
  const fStart = faceletIndex("F", 0, 0);
  const rStart = faceletIndex("R", 0, 0);
  const bStart = faceletIndex("B", 0, 0);
  const lStart = faceletIndex("L", 0, 0);

  return {
    sideRows: {
      back: cube.slice(bStart, bStart + 3),
      front: cube.slice(fStart, fStart + 3),
      left: cube.slice(lStart, lStart + 3),
      right: cube.slice(rStart, rStart + 3),
    },
    top: cube.slice(uStart, uStart + 9),
  };
}

/** Internal to the cube feature - see the indexing scheme documented on `FaceletCube`. */
export function faceletIndex(face: FaceLetter, row: number, col: number): number {
  return FACE_ORDER.indexOf(face) * 9 + row * 3 + col;
}

const FACE_NORMAL: Record<FaceLetter, readonly [number, number, number]> = {
  B: [0, 0, -1],
  D: [0, -1, 0],
  F: [0, 0, 1],
  L: [-1, 0, 0],
  R: [1, 0, 0],
  U: [0, 1, 0],
};

/** Internal to the cube feature: each face's fixed outward-normal vector. */
export function faceNormal(face: FaceLetter): readonly [number, number, number] {
  return FACE_NORMAL[face];
}

/** Internal to the cube feature: inverse of `faceNormal`, matched by exact component values. */
export function faceFromNormal(normal: readonly [number, number, number]): FaceLetter {
  const found = FACE_ORDER.find((face) => {
    const candidate = FACE_NORMAL[face];
    return candidate[0] === normal[0] && candidate[1] === normal[1] && candidate[2] === normal[2];
  });

  if (!found) {
    throw new Error(`Unrecognized facelet normal: [${normal.join(", ")}]`);
  }

  return found;
}

/**
 * Internal to the cube feature: maps a (face, row, col) facelet to its 3D position, using
 * x: L(-1) -> R(+1), y: D(-1) -> U(+1), z: B(-1) -> F(+1). Must stay the exact inverse of
 * `xyzToFaceRowCol` and agree with the row/col convention documented on `FaceletCube`.
 */
export function faceRowColToXyz(face: FaceLetter, row: number, col: number): readonly [number, number, number] {
  switch (face) {
    case "U":
      return [col - 1, 1, row - 1];
    case "D":
      return [col - 1, -1, 1 - row];
    case "F":
      return [col - 1, 1 - row, 1];
    case "B":
      return [1 - col, 1 - row, -1];
    case "R":
      return [1, 1 - row, 1 - col];
    case "L":
      return [-1, 1 - row, col - 1];
    default:
      throw new Error(`Unrecognized face: ${String(face)}`);
  }
}

/** Internal to the cube feature: exact inverse of `faceRowColToXyz` for a given face. */
export function xyzToFaceRowCol(
  face: FaceLetter,
  x: number,
  y: number,
  z: number,
): { row: number; col: number } {
  switch (face) {
    case "U":
      return { col: x + 1, row: z + 1 };
    case "D":
      return { col: x + 1, row: 1 - z };
    case "F":
      return { col: x + 1, row: 1 - y };
    case "B":
      return { col: 1 - x, row: 1 - y };
    case "R":
      return { col: 1 - z, row: 1 - y };
    case "L":
      return { col: z + 1, row: 1 - y };
    default:
      throw new Error(`Unrecognized face: ${String(face)}`);
  }
}
