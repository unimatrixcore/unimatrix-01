import { RiShapeLine, RiShapesLine } from "@remixicon/react";

import type { AlgorithmSetId } from "@/features/algorithms/types";
import { cn } from "@unimatrix/ui/public";

const SET_OPTIONS: { icon: typeof RiShapeLine; id: AlgorithmSetId; label: string }[] = [
  { icon: RiShapeLine, id: "oll", label: "OLL" },
  { icon: RiShapesLine, id: "pll", label: "PLL" },
];

export function AlgorithmSetToggle({
  onChange,
  setId,
}: {
  onChange: (setId: AlgorithmSetId) => void;
  setId: AlgorithmSetId;
}) {
  const activeIndex = SET_OPTIONS.findIndex((option) => option.id === setId);

  return (
    <div className="relative inline-flex border border-border/70" role="group">
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-1/2 bg-primary/20 transition-transform duration-200 ease-out"
        style={{ transform: `translateX(${activeIndex * 100}%)` }}
      />
      {SET_OPTIONS.map(({ icon: Icon, id, label }) => {
        const active = setId === id;

        return (
          <button
            aria-pressed={active}
            className={cn(
              "relative z-10 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            key={id}
            onClick={() => {
              onChange(id);
            }}
            type="button"
          >
            <Icon aria-hidden="true" className="size-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
