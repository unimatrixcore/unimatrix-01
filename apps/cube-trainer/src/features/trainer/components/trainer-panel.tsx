import { useEffect } from "react";
import { RiBookOpenLine, RiCheckLine, RiEyeLine, RiSkipForwardLine } from "@remixicon/react";

import { summarizeProgress } from "@/features/algorithms/progress-summary";
import type { AlgorithmCase, AlgorithmSetId } from "@/features/algorithms/types";
import { LastLayerDiagramView } from "@/features/cube/components/last-layer-diagram-view";
import { useAlgorithmTrainer } from "@/features/trainer/use-algorithm-trainer";
import { Badge, Button, Card } from "@unimatrix/ui/public";

export function TrainerPanel({
  cases,
  setId,
}: {
  cases: AlgorithmCase[];
  setId: AlgorithmSetId;
}) {
  const { currentCase, diagram, isRevealed, markStatus, progress, reveal, sessionCount, setupMoves, skip } =
    useAlgorithmTrainer(setId, cases);
  const summary = summarizeProgress(cases, progress);

  useEffect(() => {
    if (isRevealed) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.code !== "Space" || event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      reveal();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isRevealed, reveal]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="gap-1.5" variant="outline">
          {summary.known} known
        </Badge>
        <Badge className="gap-1.5" variant="outline">
          {summary.learning} learning
        </Badge>
        <Badge className="gap-1.5" variant="outline">
          {summary.new} new
        </Badge>
        <Badge className="ml-auto gap-1.5">Cards seen this session: {sessionCount}</Badge>
      </div>

      <Card
        className="site-panel site-panel-strong flex min-h-96 flex-col items-center justify-center gap-6 px-6 py-10 text-center"
        onClick={reveal}
      >
        {currentCase && diagram ? (
          <>
            <LastLayerDiagramView diagram={diagram} size={180} />

            {setupMoves ? <p className="alg-move-string break-words">{setupMoves}</p> : null}

            {isRevealed ? (
              <div
                className="w-full max-w-xl space-y-3 border-t border-border/60 pt-5"
                onClick={(event) => {
                  event.stopPropagation();
                }}
              >
                <div className="space-y-1">
                  <p className="text-xs font-medium tracking-[0.2em] text-muted-foreground uppercase">
                    {currentCase.group}
                  </p>
                  <h3 className="text-2xl font-medium tracking-[-0.04em] text-foreground">
                    {currentCase.displayName}
                  </h3>
                </div>
                <div className="space-y-2">
                  {currentCase.algorithms.map((algorithm, index) => (
                    <p className="alg-move-string break-words" key={`${currentCase.id}:${index}`}>
                      {algorithm}
                    </p>
                  ))}
                </div>
              </div>
            ) : (
              <Button
                className="gap-2"
                onClick={(event) => {
                  event.stopPropagation();
                  reveal();
                }}
                variant="outline"
              >
                <RiEyeLine aria-hidden="true" className="size-4" />
                Reveal algorithm
              </Button>
            )}

            <div
              className="flex flex-wrap items-center justify-center gap-3 pt-2"
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              <Button
                className="gap-2"
                onClick={() => {
                  markStatus("learning");
                }}
                variant="secondary"
              >
                <RiBookOpenLine aria-hidden="true" className="size-4" />
                Still learning
              </Button>
              <Button
                className="gap-2"
                onClick={() => {
                  markStatus("known");
                }}
              >
                <RiCheckLine aria-hidden="true" className="size-4" />
                Got it
              </Button>
              <Button className="gap-2" onClick={skip} variant="ghost">
                <RiSkipForwardLine aria-hidden="true" className="size-4" />
                Skip
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No cases available to train — mark some as learning in Browse to bring them back into rotation.
          </p>
        )}
      </Card>
    </div>
  );
}
