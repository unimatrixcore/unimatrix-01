import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { RiArrowLeftLine } from "@remixicon/react";
import { Button } from "@unimatrix/ui/public";

import { AlgorithmSetToggle } from "@/features/algorithms/components/algorithm-set-toggle";
import type { AlgorithmSetId } from "@/features/algorithms/types";
import { LearnCasesGrid } from "@/features/learn/components/learn-cases-grid";
import { LearnPanel } from "@/features/learn/components/learn-panel";

type ViewMode = "session" | "cases";

export function LearnSetView() {
  const [setId, setSetId] = useState<AlgorithmSetId>("oll");
  const [mode, setMode] = useState<ViewMode>("session");

  if (mode === "cases") {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button
              aria-label="Back to learning"
              onClick={() => {
                setMode("session");
              }}
              size="icon"
              variant="outline"
            >
              <RiArrowLeftLine aria-hidden="true" className="size-4" />
            </Button>
            <h1 className="text-xl font-medium tracking-[-0.03em] text-foreground">Choose cases</h1>
          </div>
          <AlgorithmSetToggle onChange={setSetId} setId={setId} />
        </div>

        <LearnCasesGrid key={setId} setId={setId} />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button asChild aria-label="Home" size="icon" variant="outline">
            <Link to="/">
              <RiArrowLeftLine aria-hidden="true" className="size-4" />
            </Link>
          </Button>
          <h1 className="text-xl font-medium tracking-[-0.03em] text-foreground">Learning</h1>
        </div>
        <div className="flex items-center gap-3">
          <AlgorithmSetToggle onChange={setSetId} setId={setId} />
          <Button
            onClick={() => {
              setMode("cases");
            }}
            variant="outline"
          >
            Choose cases
          </Button>
        </div>
      </div>

      <LearnPanel key={setId} setId={setId} />
    </div>
  );
}
