import {
  FACE_ORDER,
  createSolvedCube,
  faceFromNormal,
  faceletIndex,
  faceNormal,
  faceRowColToXyz,
  xyzToFaceRowCol,
} from "./model";
import type { FaceLetter, FaceletCube } from "./model";
import type { Move } from "./notation";

/**
 * Moves are implemented by tracking each of the 54 facelets as a rigid-body vector pair
 * (its 3D position + outward normal) and rotating the pair with a 90-degree rotation
 * matrix, rather than by hand-written per-face permutation cycles. A quarter turn is just
 * "rotate every facelet whose position lies in the turning layer(s) by one matrix
 * application" - this generalizes to wide moves, slices, and whole-cube rotations for free
 * and is far less error-prone than maintaining 18 separate cycle tables by hand.
 */
type Vec3 = readonly [number, number, number];
type Axis = "x" | "y" | "z";

interface Sticker {
  value: FaceLetter;
  pos: Vec3;
  normal: Vec3;
}

function readFacelet(cube: FaceletCube, index: number): FaceLetter {
  const value = cube[index];
  if (value === undefined) {
    throw new Error(`Facelet cube missing a value at index ${index}`);
  }
  return value;
}

function cubeToStickers(cube: FaceletCube): Sticker[] {
  const stickers: Sticker[] = [];

  for (const face of FACE_ORDER) {
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        stickers.push({
          normal: faceNormal(face),
          pos: faceRowColToXyz(face, row, col),
          value: readFacelet(cube, faceletIndex(face, row, col)),
        });
      }
    }
  }

  return stickers;
}

function stickersToCube(stickers: Sticker[]): FaceletCube {
  const cube = new Array<FaceLetter>(54);

  for (const sticker of stickers) {
    const face = faceFromNormal(sticker.normal);
    const { row, col } = xyzToFaceRowCol(face, sticker.pos[0], sticker.pos[1], sticker.pos[2]);
    cube[faceletIndex(face, row, col)] = sticker.value;
  }

  for (let i = 0; i < 54; i += 1) {
    if (cube[i] === undefined) {
      throw new Error(`Facelet cube failed to populate index ${i} while applying a move`);
    }
  }

  return cube;
}

// One 90-degree clockwise turn (as viewed from the positive end of `axis` looking toward the
// origin) for R/U/F and their wide/slice/rotation counterparts that share the same handedness.
function rotateOnce(vec: Vec3, axis: Axis): Vec3 {
  const [x, y, z] = vec;
  switch (axis) {
    case "x":
      return [x, z, -y];
    case "y":
      return [-z, y, x];
    case "z":
      return [y, -x, z];
    default:
      throw new Error(`Unrecognized axis: ${String(axis)}`);
  }
}

function rotateVec(vec: Vec3, axis: Axis, times: number): Vec3 {
  let result = vec;
  for (let i = 0; i < times; i += 1) {
    result = rotateOnce(result, axis);
  }
  return result;
}

interface MoveDefinition {
  axis: Axis;
  // +1 if this move's own clockwise direction matches rotateOnce's direction (R/U/F, their
  // wide variants, and x/y/z); -1 if it's the mirrored side (L/D/B, M/S/E follow L/F/D resp.).
  sign: 1 | -1;
  layer: (coord: number) => boolean;
}

const AXIS_COMPONENT: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

const MOVE_DEFINITIONS: Record<string, MoveDefinition> = {
  B: { axis: "z", layer: (c) => c === -1, sign: -1 },
  D: { axis: "y", layer: (c) => c === -1, sign: -1 },
  E: { axis: "y", layer: (c) => c === 0, sign: -1 },
  F: { axis: "z", layer: (c) => c === 1, sign: 1 },
  L: { axis: "x", layer: (c) => c === -1, sign: -1 },
  M: { axis: "x", layer: (c) => c === 0, sign: -1 },
  R: { axis: "x", layer: (c) => c === 1, sign: 1 },
  S: { axis: "z", layer: (c) => c === 0, sign: 1 },
  U: { axis: "y", layer: (c) => c === 1, sign: 1 },
  b: { axis: "z", layer: (c) => c === -1 || c === 0, sign: -1 },
  d: { axis: "y", layer: (c) => c === -1 || c === 0, sign: -1 },
  f: { axis: "z", layer: (c) => c === 1 || c === 0, sign: 1 },
  l: { axis: "x", layer: (c) => c === -1 || c === 0, sign: -1 },
  r: { axis: "x", layer: (c) => c === 1 || c === 0, sign: 1 },
  u: { axis: "y", layer: (c) => c === 1 || c === 0, sign: 1 },
  x: { axis: "x", layer: () => true, sign: 1 },
  y: { axis: "y", layer: () => true, sign: 1 },
  z: { axis: "z", layer: () => true, sign: 1 },
};

function applySingleMove(stickers: Sticker[], move: Move): Sticker[] {
  const definition = MOVE_DEFINITIONS[move.face];
  if (!definition) {
    throw new Error(`Unrecognized move face: ${move.face}`);
  }

  const componentIndex = AXIS_COMPONENT[definition.axis];
  const times = (((definition.sign * move.turns) % 4) + 4) % 4;

  return stickers.map((sticker) => {
    if (!definition.layer(sticker.pos[componentIndex])) return sticker;

    return {
      normal: rotateVec(sticker.normal, definition.axis, times),
      pos: rotateVec(sticker.pos, definition.axis, times),
      value: sticker.value,
    };
  });
}

export function applyMoves(cube: FaceletCube, moves: Move[]): FaceletCube {
  let stickers = cubeToStickers(cube);

  for (const move of moves) {
    stickers = applySingleMove(stickers, move);
  }

  return stickersToCube(stickers);
}

function centerSignature(cube: FaceletCube): string {
  return FACE_ORDER.map((_, i) => readFacelet(cube, i * 9 + 4)).join("");
}

// x, y, and z alone generate the cube's full 24-element rotation group, so repeatedly
// applying them from a starting state and stopping at the first state whose centers match
// a target signature is a correct-by-construction way to find the needed rotation, without
// hand-deriving a 24-entry orientation lookup table. All three turn counts (quarter, half,
// reverse-quarter) are included as direct generators - with only quarter turns, a rotation
// that's really a single x' would come out of the BFS as three separate x's (correct as a
// transform, but a confusing "x x x" in the displayed setup-move text), and a half turn
// would come out as two quarter turns instead of one x2/y2/z2.
const ORIENTATION_GENERATORS: Move[] = [
  { face: "x", turns: 1 },
  { face: "x", turns: 2 },
  { face: "x", turns: 3 },
  { face: "y", turns: 1 },
  { face: "y", turns: 2 },
  { face: "y", turns: 3 },
  { face: "z", turns: 1 },
  { face: "z", turns: 2 },
  { face: "z", turns: 3 },
];

function findRotationToSignature(
  start: FaceletCube,
  targetSignature: string,
): { cube: FaceletCube; moves: Move[] } {
  if (centerSignature(start) === targetSignature) return { cube: start, moves: [] };

  const queue: { cube: FaceletCube; moves: Move[] }[] = [{ cube: start, moves: [] }];
  const visited = new Set<string>([centerSignature(start)]);
  let head = 0;

  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    if (!current) break;

    for (const generator of ORIENTATION_GENERATORS) {
      const next = applyMoves(current.cube, [generator]);
      const signature = centerSignature(next);
      if (visited.has(signature)) continue;

      visited.add(signature);
      const moves = [...current.moves, generator];
      if (signature === targetSignature) return { cube: next, moves };
      queue.push({ cube: next, moves });
    }
  }

  throw new Error("Unable to find a corrective orientation sequence");
}

export function normalizeOrientation(cube: FaceletCube): FaceletCube {
  return findRotationToSignature(cube, FACE_ORDER.join("")).cube;
}

/**
 * Finds the whole-cube rotation (as a move list, applied from a solved cube) whose net
 * center-permutation matches what `algorithmMoves` produces. Algorithms that embed a
 * leading/trailing x/y/z (common in PLL - e.g. Aa, Ab, E, Ja) carry this rotation, and
 * undoing it *after* inverting the algorithm (post-hoc, via `normalizeOrientation` on the
 * already-inverted state) gives a different, wrong permutation: the rotation doesn't
 * commute with the algorithm's other moves, so correcting on the wrong side composes
 * differently than correcting on the right side. The correct construction pre-rotates the
 * solved cube by this same net rotation *before* inverting, so the two rotations cancel
 * exactly instead of interacting with the moves in between (see `getCaseSetup`).
 */
export function netRotationFor(algorithmMoves: Move[]): Move[] {
  const targetSignature = centerSignature(applyMoves(createSolvedCube(), algorithmMoves));
  return findRotationToSignature(createSolvedCube(), targetSignature).moves;
}
