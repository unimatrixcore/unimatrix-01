import { STATUS_DOT_CLASSES, type StatusTone } from "../../lib/status-tone.js";
import { cn } from "../../lib/utils.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.js";

export type StatusDotProps = {
  tone: StatusTone;
  label: string;
  detail?: string;
  className?: string;
};

export function StatusDot({ tone, label, detail, className }: StatusDotProps) {
  const description = detail ? `${label}: ${detail}` : label;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={description}
          tabIndex={0}
          className={cn(
            "inline-block size-2 shrink-0 rounded-full",
            STATUS_DOT_CLASSES[tone],
            className,
          )}
          role="img"
        />
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{description}</TooltipContent>
    </Tooltip>
  );
}
