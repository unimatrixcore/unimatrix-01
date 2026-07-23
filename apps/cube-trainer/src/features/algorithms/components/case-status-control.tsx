import { RiBookOpenLine, RiCheckLine, RiSparklingLine } from "@remixicon/react";

import type { CaseStatus } from "@/lib/progress-storage";
import { cn } from "@unimatrix/ui/public";

const STATUS_OPTIONS: { icon: typeof RiCheckLine; label: string; status: CaseStatus }[] = [
  { icon: RiSparklingLine, label: "New", status: "new" },
  { icon: RiBookOpenLine, label: "Learning", status: "learning" },
  { icon: RiCheckLine, label: "Known", status: "known" },
];

export function CaseStatusControl({
  onChange,
  status,
}: {
  onChange: (status: CaseStatus) => void;
  status: CaseStatus;
}) {
  return (
    <div className="inline-flex border border-border/70" role="group">
      {STATUS_OPTIONS.map(({ icon: Icon, label, status: optionStatus }, index) => {
        const active = status === optionStatus;

        return (
          <button
            aria-label={label}
            aria-pressed={active}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
              index > 0 && "border-l border-border/70",
              active
                ? "bg-primary/16 text-foreground"
                : "bg-background/72 text-muted-foreground hover:text-foreground",
            )}
            key={optionStatus}
            onClick={() => {
              onChange(optionStatus);
            }}
            type="button"
          >
            <Icon aria-hidden="true" className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
