import { useState } from "react";
import { RiBookOpenLine, RiFlashlightLine } from "@remixicon/react";

import { AlgorithmGroupSection } from "@/features/algorithms/components/algorithm-group-section";
import { getAlgorithmSet, groupCasesByGroup } from "@/features/algorithms/algorithm-sets";
import type { AlgorithmSetId } from "@/features/algorithms/types";
import { useCaseProgress } from "@/features/algorithms/use-case-progress";
import { SectionHeading } from "@/features/cube-trainer-site/components";
import { TrainerPanel } from "@/features/trainer/components/trainer-panel";
import { Badge, cn } from "@unimatrix/ui/public";

type ViewMode = "trainer" | "browse";

const MODE_OPTIONS: { icon: typeof RiFlashlightLine; label: string; mode: ViewMode }[] = [
  { icon: RiFlashlightLine, label: "Trainer", mode: "trainer" },
  { icon: RiBookOpenLine, label: "Browse", mode: "browse" },
];

export function AlgorithmSetView({ setId }: { setId: AlgorithmSetId }) {
  const [mode, setMode] = useState<ViewMode>("trainer");
  const algorithmSet = getAlgorithmSet(setId);
  const groupedCases = groupCasesByGroup(algorithmSet);
  const { progress, updateStatus } = useCaseProgress(setId);

  return (
    <div className="space-y-8">
      <SectionHeading
        badges={
          <Badge className="gap-1.5">{algorithmSet.cases.length} cases</Badge>
        }
        description={algorithmSet.description}
        title={algorithmSet.label}
        trailing={
          <div className="inline-flex border border-border/70">
            {MODE_OPTIONS.map(({ icon: Icon, label, mode: optionMode }, index) => {
              const active = mode === optionMode;

              return (
                <button
                  aria-pressed={active}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
                    index > 0 && "border-l border-border/70",
                    active
                      ? "bg-primary/16 text-foreground"
                      : "bg-background/72 text-muted-foreground hover:text-foreground",
                  )}
                  key={optionMode}
                  onClick={() => {
                    setMode(optionMode);
                  }}
                  type="button"
                >
                  <Icon aria-hidden="true" className="size-3.5" />
                  {label}
                </button>
              );
            })}
          </div>
        }
      />

      {mode === "trainer" ? (
        <TrainerPanel cases={algorithmSet.cases} setId={setId} />
      ) : (
        <div className="space-y-8">
          {groupedCases.map(({ cases, group }) => (
            <AlgorithmGroupSection
              cases={cases}
              group={group}
              key={group}
              onStatusChange={updateStatus}
              progress={progress}
            />
          ))}
        </div>
      )}
    </div>
  );
}
