import { memo, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, Scan } from "lucide-react";
import { Badge, Button, Card } from "@unimatrix/ui/public";
import type { PokerCardSuit, PokerGameplayColorState } from "@unimatrix/shared";
import "./gameplay_preview.css";

export interface GameplayReading {
  rect: { x: number; y: number; w: number; h: number };
  prediction: Record<string, unknown> | null;
  error: string | null;
}
export interface GameplayPreviewFrame {
  id: string;
  hand_id: string | null;
  captured_at: string;
  image_url: string;
  preview_url?: string;
  width?: number;
  height?: number;
  results?: Record<string, GameplayReading>;
  config_snapshot?: { regions?: Record<string, unknown> };
  color_state?: PokerGameplayColorState;
}

type Rect = GameplayReading["rect"];
type Region = { key: string; rect: Rect; color: string };

function colorForRegion(key: string) {
  // Match the region definer's semantic colors, including canonical OCR IDs.
  if (/^(community|community_cards)/.test(key)) return "#22c55e";
  if (/^(pot|split_pot)/.test(key)) return "#f59e0b";
  if (/^(game|round_id)/.test(key)) return "#ec4899";
  return "#3b82f6";
}

export function previewRegions(
  frame: GameplayPreviewFrame,
  width: number,
  height: number,
): Region[] {
  const regions = new Map<string, Rect>();
  function walk(value: unknown, key: string) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        walk(entry, `${key}[${index}]`);
      });
      return;
    }
    const object = value as Record<string, unknown>;
    if (["x", "y", "w", "h"].every((name) => typeof object[name] === "number")) {
      regions.set(key, object as Rect);
      return;
    }
    for (const [name, entry] of Object.entries(object)) walk(entry, key ? `${key}.${name}` : name);
  }
  walk(frame.config_snapshot?.regions, "");
  for (const [key, reading] of Object.entries(frame.results || {}))
    if (reading.rect) regions.set(key, reading.rect);
  return [...regions]
    .filter(
      ([, rect]) =>
        [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) &&
        rect.x >= 0 &&
        rect.y >= 0 &&
        rect.w > 0 &&
        rect.h > 0 &&
        rect.x + rect.w <= width &&
        rect.y + rect.h <= height,
    )
    .map(([key, rect]) => ({ key, rect, color: colorForRegion(key) }));
}

export function suspectedGameState(frame: GameplayPreviewFrame) {
  function reading(key: string): string | null {
    const result = frame.results?.[key];
    const text = result?.prediction?.text;
    return !result?.error &&
      result?.prediction?.schema_valid === true &&
      typeof text === "string" &&
      text.trim()
      ? text
      : null;
  }
  const indices = new Set<number>();
  const configured = frame.config_snapshot?.regions?.seats;
  if (Array.isArray(configured)) configured.forEach((_, index) => indices.add(index));
  for (const key of Object.keys(frame.color_state?.seats || {})) {
    if (/^\d+$/.test(key)) indices.add(Number(key));
  }
  for (const key of Object.keys(frame.results || {})) {
    const match = /^seats\[(\d+)\]/.exec(key);
    if (match) indices.add(Number(match[1]));
  }
  return {
    hand: reading("round_id"),
    pot: reading("pot"),
    splitPot: reading("split_pot"),
    community: Array.from({ length: 5 }, (_, index) => reading(`community_cards[${index}]`)),
    seats: [...indices]
      .sort((a, b) => a - b)
      .map((index) => ({
        index,
        inPlay: frame.color_state?.seats[String(index)]?.in_play ?? null,
        suits: frame.color_state?.seats[String(index)]?.hand_suits || [],
        name: reading(`seats[${index}].name`),
        bank: reading(`seats[${index}].bank`),
        bet: reading(`seats[${index}].bet`),
        status: reading(`seats[${index}].status`),
        cards: [reading(`seats[${index}].cards[0]`), reading(`seats[${index}].cards[1]`)],
        dealer: reading(`seats[${index}].dealer`) === "D",
      })),
  };
}

const suitSymbols: Record<PokerCardSuit, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };
function cardLabel(rank: string, suit: PokerCardSuit | null | undefined) {
  return `${rank}${suit ? suitSymbols[suit] : ""}`;
}

type SuspectedSeat = ReturnType<typeof suspectedGameState>["seats"][number];

/** Unread seats remain available without claiming they are unoccupied. */
export function hasSuspectedSeatReading(seat: SuspectedSeat) {
  return !!(
    seat.name ||
    seat.bank ||
    seat.bet ||
    seat.status ||
    seat.dealer ||
    seat.cards.some(Boolean)
  );
}

/** The current image and all annotations share one original-coordinate surface. */
export const GameplayPreview = memo(function GameplayPreview({
  frame,
  isLive = false,
}: {
  frame: GameplayPreviewFrame;
  isLive?: boolean;
}) {
  const [regionsVisible, setRegionsVisible] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const configured = frame.config_snapshot?.regions;
  const width = frame.width || Number(configured?.screen_width) || 0;
  const height = frame.height || Number(configured?.screen_height) || 0;
  const regions = useMemo(() => previewRegions(frame, width, height), [frame, width, height]);
  const state = useMemo(() => suspectedGameState(frame), [frame]);
  const activeSeats = useMemo(() => state.seats.filter((seat) => seat.inPlay !== false), [state]);
  const inactiveCount = state.seats.length - activeSeats.length;
  const visibleSeats = showInactive ? state.seats : activeSeats;
  const captured = new Date(frame.captured_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <section className="gameplay-preview" aria-label="Latest valid frame">
      <header className="gameplay-preview-heading gameplay-frame-heading">
        <div>
          <strong>{frame.hand_id ? `Hand #${frame.hand_id}` : "Valid frame"}</strong>
          <span>
            {isLive ? "Live" : "Captured"} · {captured}
          </span>
        </div>
        <div className="gameplay-preview-actions">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle region overlay"
            title="Show or hide capture regions"
            aria-pressed={regionsVisible}
            onClick={() => {
              setRegionsVisible((value) => !value);
            }}
          >
            <Scan size={16} />
          </Button>
          <Button variant="ghost" size="icon-sm" asChild>
            <a
              href={frame.image_url}
              target="_blank"
              rel="noreferrer"
              aria-label="Open original frame"
              title="Open original frame"
            >
              <ExternalLink size={16} />
            </a>
          </Button>
        </div>
      </header>
      <div
        className="gameplay-preview-surface"
        style={width > 0 && height > 0 ? { aspectRatio: `${width} / ${height}` } : undefined}
      >
        <img
          src={frame.preview_url || frame.image_url}
          alt={`Valid poker table captured at ${captured}`}
          width={width || undefined}
          height={height || undefined}
          decoding="async"
        />
        {regionsVisible && width > 0 && height > 0 && (
          <svg
            className="gameplay-region-overlay"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="xMidYMid meet"
            aria-label="Capture region overlays"
          >
            {regions.map(({ key, rect, color }) => (
              <g key={key} className="gameplay-region" style={{ color }}>
                <rect
                  x={rect.x}
                  y={rect.y}
                  width={rect.w}
                  height={rect.h}
                  vectorEffect="non-scaling-stroke"
                >
                  <title>
                    {key}
                    {frame.results?.[key]?.prediction?.text
                      ? `: ${String(frame.results[key].prediction?.text as string)}`
                      : ""}
                  </title>
                </rect>
                <text className="gameplay-region-label" x={rect.x + 3} y={Math.max(18, rect.y - 6)}>
                  {key}
                </text>
              </g>
            ))}
          </svg>
        )}
      </div>
      <section className="suspected-game-state" aria-labelledby="suspected-game-state-heading">
        <div className="suspected-game-state-heading">
          <h2 id="suspected-game-state-heading">Suspected game state</h2>
          <Badge variant="secondary" className="suspected-unverified">
            Unverified OCR
          </Badge>
        </div>
        {!frame.results ? (
          <p className="text-sm text-muted-foreground">Reading this frame…</p>
        ) : (
          <>
            <dl className="suspected-table-summary">
              <div>
                <dt>Pot</dt>
                <dd>{state.pot?.replace(/^Pot:\s*/, "") || "Unread"}</dd>
              </div>
              {state.splitPot && (
                <div>
                  <dt>Split pots</dt>
                  <dd>{state.splitPot}</dd>
                </div>
              )}
              <div className="suspected-community">
                <dt>Board</dt>
                <dd>
                  {state.community.some(Boolean) ? (
                    state.community.map(
                      (rank, index) =>
                        rank && (
                          <Badge
                            variant="secondary"
                            key={index}
                            aria-label={`Community card ${index + 1}: ${cardLabel(rank, frame.color_state?.community_suits[index])}`}
                          >
                            {cardLabel(rank, frame.color_state?.community_suits[index])}
                          </Badge>
                        ),
                    )
                  ) : (
                    <span className="suspected-unread">Board unread</span>
                  )}
                </dd>
              </div>
            </dl>
            {!!visibleSeats.length && (
              <div className="suspected-seat-grid" aria-label="Suspected player states">
                {visibleSeats.map((seat) => (
                  <Card
                    key={seat.index}
                    size="sm"
                    className="suspected-seat rounded-none border-0 shadow-none ring-0"
                  >
                    <div className="suspected-seat-heading">
                      <span className="suspected-seat-number">Seat {seat.index + 1}</span>
                      {seat.dealer && (
                        <Badge variant="secondary" title="Suspected dealer">
                          D
                        </Badge>
                      )}
                    </div>
                    <div className="suspected-player-name" title={seat.name || undefined}>
                      {seat.name || <span className="suspected-unread">Player unread</span>}
                    </div>
                    <div className="suspected-stack">
                      <span>Stack</span>
                      {seat.bank ? (
                        <strong>{seat.bank}</strong>
                      ) : (
                        <span className="suspected-unread">Unread</span>
                      )}
                    </div>
                    {(seat.bet || seat.status) && (
                      <div className="suspected-seat-chips">
                        {seat.bet && <Badge variant="secondary">Bet {seat.bet}</Badge>}
                        {seat.status && <Badge variant="secondary">{seat.status}</Badge>}
                      </div>
                    )}
                    {seat.cards.some(Boolean) && (
                      <div className="suspected-seat-ranks">
                        <span>Ranks</span>
                        {seat.cards.map(
                          (rank, index) =>
                            rank && (
                              <Badge
                                variant="secondary"
                                key={index}
                                aria-label={`Seat ${seat.index + 1} card ${index + 1}: ${cardLabel(rank, seat.suits[index])}`}
                              >
                                {cardLabel(rank, seat.suits[index])}
                              </Badge>
                            ),
                        )}
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}
            {!!inactiveCount && (
              <Button
                variant="ghost"
                size="sm"
                className="suspected-unread-toggle"
                aria-expanded={showInactive}
                onClick={() => {
                  setShowInactive((value) => !value);
                }}
              >
                {showInactive ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                {inactiveCount} inactive {inactiveCount === 1 ? "seat" : "seats"}
              </Button>
            )}
            <p className="suspected-state-note">
              Seat activity and suits use color detection; unknown seats remain visible. Values are
              estimates.
            </p>
          </>
        )}
      </section>
    </section>
  );
});
