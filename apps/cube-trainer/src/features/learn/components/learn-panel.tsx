import { useEffect, useState } from "react";
import { RiArrowLeftLine, RiArrowRightLine } from "@remixicon/react";
import { Card, Kbd } from "@unimatrix/ui/public";

import type { AlgorithmSetId } from "@/features/algorithms/types";
import { LastLayerDiagramView } from "@/features/cube/components/last-layer-diagram-view";
import { useLearnSession } from "@/features/learn/use-learn-session";

export interface LearnPanelProps {
  setId: AlgorithmSetId;
}

export function LearnPanel({ setId }: LearnPanelProps) {
  const { back, currentCase, diagram, markLearned, next, setupMoves } = useLearnSession(setId);
  const [showAlternates, setShowAlternates] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat) return;

      if (event.code === "ArrowLeft") {
        event.preventDefault();
        back();
      } else if (event.code === "ArrowRight") {
        event.preventDefault();
        next();
      } else if (event.code === "Space") {
        event.preventDefault();
        markLearned();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [back, markLearned, next]);

  if (!currentCase || !diagram) {
    return (
      <Card className="site-panel site-panel-strong flex min-h-96 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <p className="text-sm text-muted-foreground">Every case in this set is known.</p>
      </Card>
    );
  }

  const [primaryAlgorithm, ...alternateAlgorithms] = currentCase.algorithms;

  return (
    <Card className="site-panel site-panel-strong flex flex-col items-center gap-6 px-6 py-10 text-center">
      <LastLayerDiagramView diagram={diagram} label={currentCase.displayName} size={180} />

      <div className="space-y-1.5">
        <p className="text-[0.65rem] font-medium tracking-[0.25em] text-muted-foreground/70 uppercase">
          Setup
        </p>
        {setupMoves ? (
          <p className="alg-move-string break-words text-muted-foreground">{setupMoves}</p>
        ) : null}
      </div>

      <div className="w-full max-w-xl space-y-3 border-t border-border/60 pt-5">
        <div className="space-y-1.5">
          <p className="text-[0.65rem] font-medium tracking-[0.25em] text-primary/85 uppercase">
            Solution
          </p>
          <p className="alg-move-string break-words">{primaryAlgorithm}</p>
        </div>

        {alternateAlgorithms.length > 0 ? (
          <div>
            <button
              className="text-xs text-muted-foreground underline decoration-primary/35 underline-offset-4 transition-colors hover:text-foreground"
              onClick={() => {
                setShowAlternates((previous) => !previous);
              }}
              type="button"
            >
              {showAlternates
                ? "Hide alternates"
                : `Show ${alternateAlgorithms.length} alternate${alternateAlgorithms.length === 1 ? "" : "s"}`}
            </button>

            {showAlternates ? (
              <ul className="mt-2 space-y-1.5 border-t border-border/60 pt-2">
                {alternateAlgorithms.map((algorithm, index) => (
                  <li className="alg-move-string break-words" key={`${currentCase.id}:${index}`}>
                    {algorithm}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Kbd>
            <RiArrowLeftLine aria-hidden="true" className="size-3" />
          </Kbd>
          Back
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>Space</Kbd>
          Mark learned
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>
            <RiArrowRightLine aria-hidden="true" className="size-3" />
          </Kbd>
          Next
        </span>
      </div>
    </Card>
  );
}
