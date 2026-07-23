import { RiEyeOffLine } from "@remixicon/react";
import { cn } from "@unimatrix/ui/public";

import { diagramStickerColor } from "@/features/cube/last-layer-diagram";
import type { DiagramSticker, LastLayerDiagram } from "@/features/cube/last-layer-diagram";

const CELL = 40;
const GRID_START = 40;
const GRID_END = GRID_START + 3 * CELL;
const FLAP_DEPTH = 20;
const FLAP_INSET = 3;
const VIEWBOX = GRID_END + FLAP_DEPTH;

type Side = "back" | "front" | "left" | "right";

function topCellRect(row: number, col: number) {
  return { height: CELL, width: CELL, x: GRID_START + col * CELL, y: GRID_START + row * CELL };
}

/** Each flap tapers from a full-width edge touching the grid to a narrower outer tip. */
function flapPoints(side: Side, index: number): string {
  const near = GRID_START + index * CELL;
  const far = near + CELL;
  const insetNear = near + FLAP_INSET;
  const insetFar = far - FLAP_INSET;

  const points: [number, number][] = (() => {
    switch (side) {
      case "front":
        return [
          [near, GRID_END],
          [far, GRID_END],
          [insetFar, GRID_END + FLAP_DEPTH],
          [insetNear, GRID_END + FLAP_DEPTH],
        ];
      case "back":
        return [
          [near, GRID_START],
          [far, GRID_START],
          [insetFar, GRID_START - FLAP_DEPTH],
          [insetNear, GRID_START - FLAP_DEPTH],
        ];
      case "right":
        return [
          [GRID_END, near],
          [GRID_END, far],
          [GRID_END + FLAP_DEPTH, insetFar],
          [GRID_END + FLAP_DEPTH, insetNear],
        ];
      case "left":
        return [
          [GRID_START, near],
          [GRID_START, far],
          [GRID_START - FLAP_DEPTH, insetFar],
          [GRID_START - FLAP_DEPTH, insetNear],
        ];
      default:
        throw new Error(`Unrecognized side: ${String(side)}`);
    }
  })();

  return points.map(([x, y]) => `${x},${y}`).join(" ");
}

export interface LastLayerDiagramViewProps {
  className?: string;
  diagram: LastLayerDiagram;
  /** Accessible name for the diagram, e.g. a case's display name. Omit to keep the diagram decorative (`aria-hidden`) when the case is being tested rather than shown. */
  label?: string;
  size?: number;
  /** When false, renders a same-sized placeholder instead of the diagram, so the preview can be hidden without shifting layout. */
  visible?: boolean;
}

export function LastLayerDiagramView({
  className,
  diagram,
  label,
  size = 160,
  visible = true,
}: LastLayerDiagramViewProps) {
  const strokeColor = "#0f172a";

  if (!visible) {
    return (
      <div
        aria-label={label ? `${label} (preview hidden)` : "Preview hidden"}
        className={cn(
          "flex shrink-0 items-center justify-center gap-1.5 border border-dashed border-border/70 text-xs text-muted-foreground",
          className,
        )}
        role={label ? "img" : undefined}
        style={{ height: size, width: size }}
      >
        <RiEyeOffLine aria-hidden="true" className="size-4" />
        Hidden
      </div>
    );
  }

  const renderTop = () =>
    diagram.top.map((sticker, index) => {
      const row = Math.floor(index / 3);
      const col = index % 3;
      const { height, width, x, y } = topCellRect(row, col);

      return (
        <rect
          fill={diagramStickerColor(sticker)}
          height={height}
          key={`top-${index}`}
          stroke={strokeColor}
          strokeWidth={1.5}
          width={width}
          x={x}
          y={y}
        />
      );
    });

  const renderSide = (side: Side, stickers: DiagramSticker[]) =>
    stickers.map((sticker, index) => (
      <polygon
        fill={diagramStickerColor(sticker)}
        key={`${side}-${index}`}
        points={flapPoints(side, index)}
        stroke={strokeColor}
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    ));

  return (
    <svg
      aria-hidden={label ? undefined : "true"}
      aria-label={label}
      className={cn("shrink-0", className)}
      height={size}
      role={label ? "img" : undefined}
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      width={size}
    >
      {renderSide("back", diagram.sides.back)}
      {renderSide("left", diagram.sides.left)}
      {renderSide("right", diagram.sides.right)}
      {renderSide("front", diagram.sides.front)}
      {renderTop()}
    </svg>
  );
}
