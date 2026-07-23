import { useEffect } from "react";

import type { AlgorithmCase, AlgorithmSetId } from "@/features/algorithms/types";
import { LastLayerDiagramView } from "@/features/cube/components/last-layer-diagram-view";
import { useAlgorithmTrainer } from "@/features/trainer/use-algorithm-trainer";
import { Card, Kbd } from "@unimatrix/ui/public";

export function TrainerPanel({
  cases,
  setId,
}: {
  cases: AlgorithmCase[];
  setId: AlgorithmSetId;
}) {
  const { currentCase, diagram, next, setupMoves } = useAlgorithmTrainer(setId, cases);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat || event.code !== "Space" || event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      next();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [next]);

  return (
    <Card className="site-panel site-panel-strong flex min-h-96 flex-col items-center justify-center gap-6 px-6 py-10 text-center">
      {currentCase && diagram ? (
        <>
          <LastLayerDiagramView diagram={diagram} size={180} />

          {setupMoves ? <p className="alg-move-string break-words">{setupMoves}</p> : null}

          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Kbd>Space</Kbd>
            Next case
          </span>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No cases enabled — choose some cases to start training.
        </p>
      )}
    </Card>
  );
}
