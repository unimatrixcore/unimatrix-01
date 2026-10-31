import { cn } from "../lib/utils.js";
import { getUptimeTone, type StatusTone } from "../lib/status-tone.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip.js";

export interface HealthHistoryDay {
  from: number;
  to: number;
  uptimePercent: number | null;
  coveragePercent: number;
}

export interface HealthHistoryProps {
  days: readonly HealthHistoryDay[];
  label?: string;
}

const barClasses: Readonly<Record<StatusTone, string>> = {
  ok: "bg-emerald-500/70",
  warn: "bg-amber-500/80",
  bad: "bg-destructive/80",
  idle: "bg-muted-foreground/30",
};

export function HealthHistory({ days, label = "Daily uptime" }: HealthHistoryProps) {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex gap-1" role="group" aria-label={label}>
        {days.map((day) => {
          const date = new Date(day.from).toLocaleDateString(undefined, {
            day: "2-digit",
            month: "short",
            timeZone: "UTC",
          });
          const observed = day.coveragePercent > 0 && day.uptimePercent !== null;
          const description = observed
            ? `${day.uptimePercent?.toFixed(2)}% uptime · ${day.coveragePercent.toFixed(2)}% observed`
            : "No observations";
          const accessibleLabel = `${date} UTC · ${description}`;
          const tone = getUptimeTone(observed ? (day.uptimePercent ?? 0) / 100 : null);

          return (
            <Tooltip key={day.from}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={accessibleLabel}
                  className={cn(
                    "relative h-7 min-w-0 flex-1 bg-muted-foreground/30 focus-visible:outline-2 focus-visible:outline-offset-2",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute inset-x-0 bottom-0",
                      barClasses[tone],
                    )}
                    style={{ height: `${observed ? day.coveragePercent : 0}%` }}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent sideOffset={6}>{accessibleLabel}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
