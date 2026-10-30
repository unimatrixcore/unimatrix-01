import { STATUS_DOT_CLASSES, getUptimeTone } from "../../lib/status-tone.js";
import { cn } from "../../lib/utils.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.js";

export type UptimeSample = {
  key: string;
  label: string;
  uptime?: number | null;
};

export type UptimeStripProps = {
  samples: readonly UptimeSample[];
  label: string;
  className?: string;
};

export function UptimeStrip({ samples, label, className }: UptimeStripProps) {
  return (
    <div aria-label={label} className={cn("flex min-w-0 gap-0.5", className)} role="group">
      {samples.map((sample) => {
        const tone = getUptimeTone(sample.uptime);
        const description = `${sample.label}: ${tone === "idle" ? "No reading" : `${(sample.uptime! * 100).toFixed(2)}% uptime`}`;
        return (
          <Tooltip key={sample.key}>
            <TooltipTrigger asChild>
              <span
                aria-label={description}
                className={cn(
                  "block h-7 min-w-0 flex-1",
                  STATUS_DOT_CLASSES[tone],
                  tone === "ok" ? "opacity-70" : tone !== "idle" && "opacity-80",
                )}
                role="img"
              />
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{description}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
