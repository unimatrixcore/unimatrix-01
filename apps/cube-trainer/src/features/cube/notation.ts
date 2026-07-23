export interface Move {
  face: string;
  turns: number;
}

const MOVE_TOKEN = /^([UDLRFBudlrfbMSExyz])('|2|3)?$/;

export function parseAlgorithm(alg: string): Move[] {
  const withoutGrouping = alg.replace(/[()]/g, " ");
  const tokens = withoutGrouping.split(/\s+/).filter((token) => token.length > 0);
  const moves: Move[] = [];

  for (const token of tokens) {
    const match = MOVE_TOKEN.exec(token);
    if (!match) continue;

    const face = match[1];
    const modifier = match[2];
    if (!face) continue;

    const turns = modifier === "'" || modifier === "3" ? 3 : modifier === "2" ? 2 : 1;
    moves.push({ face, turns });
  }

  return moves;
}

export function invertMoves(moves: Move[]): Move[] {
  return [...moves].reverse().map((move) => ({ face: move.face, turns: (4 - move.turns) % 4 }));
}

export function movesToString(moves: Move[]): string {
  return moves
    .map((move) => {
      if (move.turns === 2) return `${move.face}2`;
      if (move.turns === 3) return `${move.face}'`;
      return move.face;
    })
    .join(" ");
}
