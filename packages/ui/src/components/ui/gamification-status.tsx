import { cn } from "../../lib/utils.js";

export interface GamificationStatusProps {
  points: number;
  streak: number;
  elapsedMs: number;
  clockState: "reading" | "editing" | "paused" | "loading";
  ids?: { score?: string; timer?: string; streak?: string };
  className?: string;
  ariaLabel?: string;
  labels?: {
    points?: string;
    streak?: string;
    reading?: string;
    editing?: string;
    paused?: string;
    loading?: string;
  };
}

function displayNumber(value: number): number {
  return Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))
    : 0;
}

export function GamificationStatus({
  points,
  streak,
  elapsedMs,
  clockState,
  ids,
  className,
  ariaLabel = "Session progress",
  labels,
}: GamificationStatusProps) {
  const seconds = Math.floor(displayNumber(elapsedMs) / 1000);
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const clockLabel = {
    reading: labels?.reading ?? "Reading",
    editing: labels?.editing ?? "Editing · clock paused · no time penalty",
    paused: labels?.paused ?? "Paused",
    loading: labels?.loading ?? "Loading · clock paused",
  }[clockState];
  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground",
        className,
      )}
    >
      <span id={ids?.score}>
        <span className="font-mono tabular-nums text-foreground">{displayNumber(points)}</span>{" "}
        {labels?.points ?? "points"}
      </span>
      <span id={ids?.streak}>
        <span className="font-mono tabular-nums text-foreground">{displayNumber(streak)}</span>{" "}
        {labels?.streak ?? "streak"}
      </span>
      <span id={ids?.timer} className="inline-flex flex-wrap items-center gap-x-2">
        <span className="font-mono tabular-nums text-foreground">{elapsed}</span>
        <span>{clockLabel}</span>
      </span>
    </div>
  );
}
