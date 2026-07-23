import { useMemo } from "react";
import { RiCheckLine } from "@remixicon/react";

import type { AlgorithmCase, AlgorithmSetId } from "@/features/algorithms/types";
import { LastLayerDiagramView } from "@/features/cube/components/last-layer-diagram-view";
import { deriveDiagramForSet } from "@/features/cube/last-layer-diagram";
import { getCaseSetup } from "@/features/trainer/case-setup";
import { cn } from "@unimatrix/ui/public";

/**
 * A single case as a diagram + name, where the whole card is the interactive element
 * (a toggle in a training/learn pool) rather than hosting a separate control inside it.
 * `learned` overlays a badge in the top-left corner (absolutely positioned, so it never
 * changes the card's height) instead of adding a row to the layout.
 */
export function CasePreviewCard({
  algorithmCase,
  dimmed = false,
  learned = false,
  onClick,
  pressed,
  setId,
}: {
  algorithmCase: AlgorithmCase;
  dimmed?: boolean;
  learned?: boolean;
  onClick: () => void;
  pressed?: boolean;
  setId: AlgorithmSetId;
}) {
  const diagram = useMemo(
    () => deriveDiagramForSet(setId, getCaseSetup(algorithmCase).cube),
    [algorithmCase, setId],
  );

  return (
    <button
      aria-label={algorithmCase.displayName}
      aria-pressed={pressed}
      className={cn(
        "site-panel relative flex flex-col items-center gap-2 px-3 py-4 text-center transition-[opacity,background-color] hover:bg-primary/8",
        dimmed && "opacity-40 hover:opacity-70",
      )}
      onClick={onClick}
      type="button"
    >
      {learned ? (
        <span className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 text-[0.6rem] font-medium tracking-[0.02em] text-primary uppercase">
          <RiCheckLine aria-hidden="true" className="size-3" />
          Learned
        </span>
      ) : null}
      <LastLayerDiagramView diagram={diagram} size={64} />
      <span className="text-xs font-medium text-foreground">{algorithmCase.displayName}</span>
    </button>
  );
}
