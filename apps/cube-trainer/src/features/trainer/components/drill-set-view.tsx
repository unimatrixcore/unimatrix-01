import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { RiArrowLeftLine, RiEyeLine, RiEyeOffLine } from "@remixicon/react";
import { Button } from "@unimatrix/ui/public";

import { getAlgorithmSet } from "@/features/algorithms/algorithm-sets";
import { AlgorithmSetToggle } from "@/features/algorithms/components/algorithm-set-toggle";
import type { CaseFilterMode } from "@/features/algorithms/components/case-category-filter";
import { CaseCategoryFilter } from "@/features/algorithms/components/case-category-filter";
import type { AlgorithmSetId } from "@/features/algorithms/types";
import { DrillCasesGrid } from "@/features/trainer/components/drill-cases-grid";
import { TrainerPanel } from "@/features/trainer/components/trainer-panel";

type ViewMode = "drill" | "cases";

export function DrillSetView() {
  const [setId, setSetId] = useState<AlgorithmSetId>("oll");
  const [mode, setMode] = useState<ViewMode>("drill");
  const [previewVisible, setPreviewVisible] = useState(true);
  const [caseFilterMode, setCaseFilterMode] = useState<CaseFilterMode>("all");
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const algorithmSet = getAlgorithmSet(setId);

  useEffect(() => {
    setCaseFilterMode("all");
    setSelectedGroups([]);
  }, [setId]);

  if (mode === "cases") {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button
              aria-label="Back to drilling"
              onClick={() => {
                setMode("drill");
              }}
              size="icon"
              variant="outline"
            >
              <RiArrowLeftLine aria-hidden="true" className="size-4" />
            </Button>
            <h1 className="text-xl font-medium tracking-[-0.03em] text-foreground">Choose cases</h1>
          </div>
          <CaseCategoryFilter
            groups={algorithmSet.groupOrder}
            mode={caseFilterMode}
            onModeChange={setCaseFilterMode}
            onSelectedGroupsChange={setSelectedGroups}
            selectedGroups={selectedGroups}
          />
        </div>

        <DrillCasesGrid
          key={setId}
          mode={caseFilterMode}
          selectedGroups={selectedGroups}
          setId={setId}
        />
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
          <h1 className="text-xl font-medium tracking-[-0.03em] text-foreground">Drilling</h1>
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

      <TrainerPanel
        cases={algorithmSet.cases}
        key={setId}
        previewVisible={previewVisible}
        setId={setId}
      />

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
