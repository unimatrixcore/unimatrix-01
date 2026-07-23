import { getAlgorithmSet, groupCasesByGroup } from "@/features/algorithms/algorithm-sets";
import { AlgorithmGroupSection } from "@/features/algorithms/components/algorithm-group-section";
import type { AlgorithmSetId } from "@/features/algorithms/types";
import { useCasePool } from "@/features/algorithms/use-case-pool";
import { useCaseProgress } from "@/features/algorithms/use-case-progress";

export function TrainCasesGrid({ setId }: { setId: AlgorithmSetId }) {
  const algorithmSet = getAlgorithmSet(setId);
  const groupedCases = groupCasesByGroup(algorithmSet);
  const { pool, setEnabled } = useCasePool(setId);
  const { progress } = useCaseProgress(setId);

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
