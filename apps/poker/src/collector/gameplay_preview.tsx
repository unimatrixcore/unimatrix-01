import { memo, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, Scan } from "lucide-react";
import { Badge, Button, Card } from "@unimatrix/ui/public";
import type {
  PokerCardSuit,
  PokerGameplayColorState,
  PokerGameplayCropMask,
  PokerGameplayFrameVerification,
  PokerGameplayReadingVerification,
} from "@unimatrix/shared";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@unimatrix/ui/editor";
import "./gameplay_preview.css";

export interface GameplayReading {
  rect: { x: number; y: number; w: number; h: number };
  prediction: Record<string, unknown> | null;
  error: string | null;
  verification?: PokerGameplayReadingVerification;
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
  effective_results?: Record<string, GameplayReading>;
  effective_config_snapshot?: {
    region_profile_id: string;
    regions: {
      viewport: { width: number; height: number };
      regions: {
        id: string;
        ocr?: boolean;
        overlay?: boolean;
        localization_error?: string;
        presence?: {
          state: "present" | "absent" | "ambiguous" | "visual_indicator";
          reason: string;
          policy: string;
        };
        crop_mask?: PokerGameplayCropMask;
        bounds: { x: number; y: number; width: number; height: number };
        polygon?: { x: number; y: number }[];
      }[];
      legacy_seat_offset?: number;
    };
  };
  color_state?: PokerGameplayColorState;
  verification?: PokerGameplayFrameVerification;
}

export function gameplayVerificationText(verification?: PokerGameplayFrameVerification): string {
  if (!verification) return "Unverified OCR";
  const labels: Record<PokerGameplayFrameVerification["status"], string> = {
    unverified: "Unverified OCR",
    partial: "Partial",
    verified: "Verified",
    needs_review: "Needs review",
    unavailable: "Verification unavailable",
  };
  return [
    labels[verification.status],
    `${verification.verified}/${verification.total}`,
    ...(verification.needs_review ? [`${verification.needs_review} need review`] : []),
    ...(verification.unsupported ? [`${verification.unsupported} unsupported`] : []),
  ].join(" · ");
}

function GameplayVerificationBadge({
  verification,
}: {
  verification: PokerGameplayFrameVerification | undefined;
}) {
  const badge = (
    <Badge
      variant="secondary"
      className="suspected-verification"
      aria-label={`Frame verification: ${gameplayVerificationText(verification)}`}
      tabIndex={verification ? 0 : undefined}
    >
      {gameplayVerificationText(verification)}
    </Badge>
  );
  if (!verification) return badge;
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent className="suspected-verification-details">
          <span>{verification.unverified} unverified</span>
          <span>Profile {verification.region_profile_id}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type Rect = GameplayReading["rect"];
type Region = {
  key: string;
  rect: Rect;
  color: string;
  polygon?: { x: number; y: number }[];
  crop_mask?: PokerGameplayCropMask;
};

export function gameplayMaskPaths(
  mask: PokerGameplayCropMask,
  origin: { x: number; y: number },
): string[] {
  return mask.panels.map(({ bounds: b, corners: c }) => {
    const x = Math.floor(origin.x) + b.x,
      y = Math.floor(origin.y) + b.y,
      r = x + b.width,
      bottom = y + b.height;
    const [tl, tr, br, bl] = c;
    return `M ${x + tl.x},${y} H ${r - tr.x} A ${tr.x},${tr.y} 0 0 1 ${r},${y + tr.y} V ${bottom - br.y} A ${br.x},${br.y} 0 0 1 ${r - br.x},${bottom} H ${x + bl.x} A ${bl.x},${bl.y} 0 0 1 ${x},${bottom - bl.y} V ${y + tl.y} A ${tl.x},${tl.y} 0 0 1 ${x + tl.x},${y} Z`;
  });
}

function colorForRegion(key: string) {
  if (/^(board|community|community_cards)/.test(key)) return "#22c55e";
  if (/^(pot|split_pot)/.test(key)) return "#f59e0b";
  if (/^(game|round_id)/.test(key)) return "#ec4899";
  return "#3b82f6";
}

export function previewRegions(
  frame: GameplayPreviewFrame,
  width: number,
  height: number,
): Region[] {
  if (frame.effective_config_snapshot) {
    const profile = frame.effective_config_snapshot.regions;
    if (profile.viewport.width !== width || profile.viewport.height !== height) return [];
    return profile.regions.flatMap((region) => {
      if (
        region.ocr === false ||
        region.overlay === false ||
        region.presence?.state === "absent" ||
        region.localization_error
      )
        return [];
      const { x, y, width: w, height: h } = region.bounds;
      if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return [];
      return [
        {
          key: region.id,
          rect: { x, y, w, h },
          color: colorForRegion(region.id),
          ...(region.polygon ? { polygon: region.polygon } : {}),
          ...(region.crop_mask ? { crop_mask: region.crop_mask } : {}),
        },
      ];
    });
  }
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
  const effective = frame.effective_results;
  const results = effective || frame.results;
  const effectiveKeys = [
    ...Object.keys(effective || {}),
    ...(frame.effective_config_snapshot?.regions.regions.map((region) => region.id) || []),
  ];
  const modern =
    !!effective &&
    !effectiveKeys.some(
      (key) =>
        key === "round_id" ||
        key === "split_pot" ||
        /^seats\[/.test(key) ||
        /^community_cards\[/.test(key),
    );
  function reading(key: string): string | null {
    const result = results?.[key];
    const text = result?.prediction?.text;
    const reviewState = result?.prediction?.review_state;
    return !result?.error &&
      (result?.prediction?.schema_valid === true ||
        (typeof reviewState === "string" &&
          ["manual", "legacy_verified"].includes(reviewState) &&
          result?.prediction?.outside_contract === true)) &&
      typeof text === "string"
      ? text
      : null;
  }
  const indices = new Set<number>();
  if (effective)
    for (const key of [
      ...Object.keys(effective),
      ...(frame.effective_config_snapshot?.regions.regions.map((region) => region.id) || []),
    ]) {
      const match = /^seat\.(\d+)\./.exec(key) || /^seats\[(\d+)\]/.exec(key);
      if (match) indices.add(Number(match[1]));
    }
  const configured = frame.config_snapshot?.regions?.seats;
  if (!effective && Array.isArray(configured)) configured.forEach((_, index) => indices.add(index));
  for (const key of Object.keys(frame.color_state?.seats || {})) {
    if (/^\d+$/.test(key))
      indices.add(
        modern
          ? (Number(key) + (frame.effective_config_snapshot?.regions.legacy_seat_offset || 0)) % 9
          : Number(key),
      );
  }
  for (const key of Object.keys(effective ? {} : frame.results || {})) {
    const match = /^seats\[(\d+)\]/.exec(key);
    if (match) indices.add(Number(match[1]));
  }
  const seatColor = (index: number) =>
    frame.color_state?.seats[
      String(
        modern
          ? (index - (frame.effective_config_snapshot?.regions.legacy_seat_offset || 0) + 9) % 9
          : index,
      )
    ];
  const suit = (value: string | null): PokerCardSuit | null =>
    value === "d" || value === "h" || value === "c" || value === "s" ? value : null;
  const suitReading = (key: string, fallback: PokerCardSuit | null | undefined) => {
    const value = reading(key);
    return value === null ? (fallback ?? null) : suit(value);
  };
  return {
    hand: reading(modern ? "game.id" : "round_id"),
    pot: reading(modern ? "pot.total" : "pot"),
    splitPot: modern
      ? Array.from({ length: 10 }, (_, i) => reading(`pot.${i}`))
          .filter(Boolean)
          .join(" · ")
      : reading("split_pot"),
    community: Array.from({ length: 5 }, (_, index) =>
      reading(modern ? `board.${index}.rank` : `community_cards[${index}]`),
    ),
    communitySuits: Array.from({ length: 5 }, (_, index) =>
      suitReading(
        modern ? `board.${index}.suit` : `community_cards[${index}].suit`,
        frame.color_state?.community_suits[index],
      ),
    ),
    seats: [...indices]
      .sort((a, b) => a - b)
      .map((index) => ({
        index,
        inPlay: seatColor(index)?.in_play ?? null,
        suits: [0, 1].map((slot) =>
          suitReading(
            modern ? `seat.${index}.card.${slot}.suit` : `seats[${index}].cards[${slot}].suit`,
            seatColor(index)?.hand_suits[slot],
          ),
        ),
        name: reading(modern ? `seat.${index}.name` : `seats[${index}].name`),
        bank: reading(modern ? `seat.${index}.bank` : `seats[${index}].bank`),
        bet: reading(modern ? `seat.${index}.bet` : `seats[${index}].bet`),
        status: modern
          ? (reading(`seat.${index}.action`) ?? reading(`seat.${index}.status`))
          : reading(`seats[${index}].status`),
        cards: modern
          ? [reading(`seat.${index}.card.0.rank`), reading(`seat.${index}.card.1.rank`)]
          : [reading(`seats[${index}].cards[0]`), reading(`seats[${index}].cards[1]`)],
        dealer: reading(modern ? `seat.${index}.dealer` : `seats[${index}].dealer`) === "D",
      })),
  };
}

const suitSymbols: Record<PokerCardSuit, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };
function cardLabel(rank: string, suit: PokerCardSuit | null | undefined) {
  return `${rank}${suit ? suitSymbols[suit] : ""}`;
}
function cardPresentation(rank: string, suit: PokerCardSuit | null | undefined) {
  return (
    <>
      {rank}
      {suit && (
        <span className="poker-suit-symbol" data-suit={suit}>
          {suit === "h" ? "♥︎" : suitSymbols[suit]}
        </span>
      )}
    </>
  );
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
            {regions.map(({ key, rect, color, polygon, crop_mask }, index) => (
              <g key={key} className="gameplay-region" style={{ color }}>
                {crop_mask ? (
                  <>
                    <defs>
                      <clipPath id={`gameplay-mask-${frame.id}-${index}`}>
                        <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} />
                      </clipPath>
                    </defs>
                    <g clipPath={`url(#gameplay-mask-${frame.id}-${index})`}>
                      {gameplayMaskPaths(crop_mask, rect).map((path, i) => (
                        <path key={i} d={path} vectorEffect="non-scaling-stroke">
                          <title>{key}</title>
                        </path>
                      ))}
                    </g>
                  </>
                ) : polygon ? (
                  <polygon
                    points={polygon.map((point) => `${point.x},${point.y}`).join(" ")}
                    vectorEffect="non-scaling-stroke"
                  >
                    <title>{key}</title>
                  </polygon>
                ) : (
                  <rect
                    x={rect.x}
                    y={rect.y}
                    width={rect.w}
                    height={rect.h}
                    vectorEffect="non-scaling-stroke"
                  >
                    <title>
                      {key}
                      {(frame.effective_results || frame.results)?.[key]?.prediction?.text
                        ? `: ${String((frame.effective_results || frame.results)![key]!.prediction?.text as string)}`
                        : ""}
                    </title>
                  </rect>
                )}
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
          <GameplayVerificationBadge verification={frame.verification} />
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
                            aria-label={`Community card ${index + 1}: ${cardLabel(rank, state.communitySuits[index])}`}
                          >
                            {cardPresentation(rank, state.communitySuits[index])}
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
                                {cardPresentation(rank, seat.suits[index])}
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
          </>
        )}
      </section>
    </section>
  );
});
