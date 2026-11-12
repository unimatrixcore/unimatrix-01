import type { PokerRect, PokerRegions } from "@unimatrix/shared";

export interface Point {
  x: number;
  y: number;
}
export interface EditorView {
  scale: number;
  offX: number;
  offY: number;
  zoom: number;
  panX: number;
  panY: number;
}
export interface EditorRegion {
  key: string;
  label: string;
  cat: "community" | "pot" | "game" | "seat";
}
export const regionColors = {
  community: "#22c55e",
  pot: "#f59e0b",
  seat: "#3b82f6",
  game: "#ec4899",
} as const;
export function editorRegions(): EditorRegion[] {
  const fields = [
    ["name", "Username"],
    ["nameplate", "Nameplate Background"],
    ["bank", "Stack"],
    ["bet", "Current Bet"],
    ["hand_0", "Hand Card 0"],
    ["hand_1", "Hand Card 1"],
    ["status", "Status"],
    ["dealer", "Dealer Button"],
  ] as const;
  return [
    ...Array.from({ length: 5 }, (_, index): EditorRegion => ({
      key: `community.card_${index + 1}`,
      label: `Community Card ${index + 1}`,
      cat: "community",
    })),
    { key: "pot.main", label: "Main Pot", cat: "pot" },
    { key: "pot.split", label: "Split Pot", cat: "pot" },
    { key: "round_id", label: "Round ID", cat: "game" },
    ...Array.from({ length: 9 }, (_, seat) =>
      fields.map(([field, label]): EditorRegion => ({
        key: `seat.${seat}.${field}`,
        label: `Seat ${seat} — ${label}`,
        cat: "seat",
      })),
    ).flat(),
  ];
}
export function fitView(
  canvasWidth: number,
  canvasHeight: number,
  imageWidth: number,
  imageHeight: number,
  previous: Pick<EditorView, "zoom" | "panX" | "panY"> = { zoom: 1, panX: 0, panY: 0 },
): EditorView {
  const scale = Math.min(canvasWidth / imageWidth, canvasHeight / imageHeight);
  return {
    ...previous,
    scale,
    offX: Math.round((canvasWidth - imageWidth * scale) / 2),
    offY: Math.round((canvasHeight - imageHeight * scale) / 2),
  };
}
export function toNatural(point: Point, view: EditorView): Point {
  return {
    x: ((point.x - view.panX) / view.zoom - view.offX) / view.scale,
    y: ((point.y - view.panY) / view.zoom - view.offY) / view.scale,
  };
}
export function fromNatural(point: Point, view: EditorView): Point {
  return {
    x: (point.x * view.scale + view.offX) * view.zoom + view.panX,
    y: (point.y * view.scale + view.offY) * view.zoom + view.panY,
  };
}
export function drawnBox(start: Point, end: Point, view: EditorView): PokerRect | null {
  const left = Math.min(start.x, end.x),
    top = Math.min(start.y, end.y),
    right = Math.max(start.x, end.x),
    bottom = Math.max(start.y, end.y);
  if (right - left < 5 || bottom - top < 5 || view.scale <= 0) return null;
  const first = toNatural({ x: left, y: top }, view),
    last = toNatural({ x: right, y: bottom }, view);
  return {
    x: Math.round(first.x),
    y: Math.round(first.y),
    w: Math.round(last.x - first.x),
    h: Math.round(last.y - first.y),
  };
}
export function zoomAt(view: EditorView, mouse: Point, deltaY: number): EditorView {
  const zoom = Math.min(10, Math.max(1, view.zoom * (deltaY < 0 ? 1.1 : 0.9)));
  return zoom === 1
    ? { ...view, zoom, panX: 0, panY: 0 }
    : {
        ...view,
        zoom,
        panX: mouse.x - ((mouse.x - view.panX) * zoom) / view.zoom,
        panY: mouse.y - ((mouse.y - view.panY) * zoom) / view.zoom,
      };
}
export function nextUndefined(
  regions: readonly EditorRegion[],
  defined: PokerRegions,
  from = 0,
): number {
  for (let index = from + 1; index < regions.length; index++)
    if (!defined[regions[index]?.key ?? ""]) return index;
  for (let index = 0; index < from; index++) if (!defined[regions[index]?.key ?? ""]) return index;
  return from;
}
export function formatVideoTime(seconds: number): string {
  const finite = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return `${Math.floor(finite / 60)}:${String(Math.floor(finite % 60)).padStart(2, "0")}`;
}
