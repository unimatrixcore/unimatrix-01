import { useState } from "react";

import { CaseStatusControl } from "@/features/algorithms/components/case-status-control";
import type { AlgorithmCase } from "@/features/algorithms/types";
import type { CaseStatus } from "@/lib/progress-storage";
import { Card, cn } from "@unimatrix/ui/public";

export function AlgorithmCaseCard({
  algorithmCase,
  onStatusChange,
  status,
}: {
  algorithmCase: AlgorithmCase;
  onStatusChange: (status: CaseStatus) => void;
  status: CaseStatus;
}) {
  const [showAlternates, setShowAlternates] = useState(false);
  const [primaryAlgorithm, ...alternateAlgorithms] = algorithmCase.algorithms;

  return (
    <Card className="site-panel h-full overflow-hidden px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-medium tracking-[-0.02em] text-foreground">
          {algorithmCase.displayName}
        </h3>
        <CaseStatusControl onChange={onStatusChange} status={status} />
      </div>

      <p className="alg-move-string mt-3 break-words">{primaryAlgorithm}</p>

      {alternateAlgorithms.length > 0 ? (
        <div className="mt-2">
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
            <ul className={cn("mt-2 space-y-1.5 border-t border-border/60 pt-2")}>
              {alternateAlgorithms.map((algorithm, index) => (
                <li className="alg-move-string break-words" key={`${algorithmCase.id}:${index}`}>
                  {algorithm}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
