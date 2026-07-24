import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { RiArrowLeftLine, RiEyeLine, RiEyeOffLine } from "@remixicon/react";
import { Button } from "@unimatrix/ui/public";

import { AlgorithmSetToggle } from "@/features/algorithms/components/algorithm-set-toggle";
import type { AlgorithmSetId } from "@/features/algorithms/types";
import { LearnCasesGrid } from "@/features/learn/components/learn-cases-grid";
import { LearnPanel } from "@/features/learn/components/learn-panel";

type ViewMode = "session" | "cases";

export function LearnSetView() {
  const [setId, setSetId] = useState<AlgorithmSetId>("oll");
  const [mode, setMode] = useState<ViewMode>("session");
  const [previewVisible, setPreviewVisible] = useState(true);

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
        <Button
          onClick={() => {
            setMode("cases");
          }}
          variant="outline"
        >
          Choose cases
        </Button>
      </div>

      <LearnPanel key={setId} previewVisible={previewVisible} setId={setId} />

      <div className="flex items-center justify-between gap-4">
        <AlgorithmSetToggle onChange={setSetId} setId={setId} />
        <Button
          aria-label={previewVisible ? "Hide cube preview" : "Show cube preview"}
          aria-pressed={previewVisible}
          onClick={() => {
            setPreviewVisible((visible) => !visible);
          }}
          size="icon"
          variant="outline"
        >
          {previewVisible ? (
            <RiEyeLine aria-hidden="true" className="size-4" />
          ) : (
            <RiEyeOffLine aria-hidden="true" className="size-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
