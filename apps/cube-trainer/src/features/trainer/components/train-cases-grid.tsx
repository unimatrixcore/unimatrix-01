import { useMemo } from "react";

import { getAlgorithmSet, groupCasesByGroup } from "@/features/algorithms/algorithm-sets";
import { AlgorithmGroupSection } from "@/features/algorithms/components/algorithm-group-section";
import type { CaseFilterMode } from "@/features/algorithms/components/case-category-filter";
import type { AlgorithmSetId } from "@/features/algorithms/types";
import { useCasePool } from "@/features/algorithms/use-case-pool";
import { useCaseProgress } from "@/features/algorithms/use-case-progress";

export function TrainCasesGrid({
  mode,
  selectedGroups,
  setId,
}: {
  mode: CaseFilterMode;
  selectedGroups: string[];
  setId: AlgorithmSetId;
}) {
  const algorithmSet = getAlgorithmSet(setId);
  const { pool, setEnabled } = useCasePool(setId);
  const { progress } = useCaseProgress(setId);

  const groupedCases = useMemo(
    () =>
      groupCasesByGroup(algorithmSet)
        .filter(({ group }) => selectedGroups.length === 0 || selectedGroups.includes(group))
        .map(({ cases, group }) => ({
          cases:
            mode === "onlyLearned"
              ? cases.filter((algorithmCase) => progress[algorithmCase.id] === "known")
              : cases,
          group,
        })),
    [algorithmSet, mode, progress, selectedGroups],
  );

  if (groupedCases.every(({ cases }) => cases.length === 0)) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        No cases match the current filters.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {groupedCases.map(({ cases, group }) => (
        <AlgorithmGroupSection
          cases={cases}
          group={group}
          key={group}
          onEnabledChange={setEnabled}
          pool={pool}
          progress={progress}
          setId={setId}
        />
      ))}
    </div>
  );
}
