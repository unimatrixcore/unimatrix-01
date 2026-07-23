import { getAlgorithmSet, groupCasesByGroup } from "@/features/algorithms/algorithm-sets";
import { CasePreviewCard } from "@/features/algorithms/components/case-preview-card";
import type { AlgorithmSetId } from "@/features/algorithms/types";
import { useCaseProgress } from "@/features/algorithms/use-case-progress";

export function LearnCasesGrid({ setId }: { setId: AlgorithmSetId }) {
  const algorithmSet = getAlgorithmSet(setId);
  const groupedCases = groupCasesByGroup(algorithmSet);
  const { progress, updateStatus } = useCaseProgress(setId);

  return (
    <div className="space-y-8">
      {groupedCases.map(({ cases, group }) => {
        if (cases.length === 0) return null;

        return (
          <section className="space-y-3" key={group}>
            <h3 className="text-xs font-medium tracking-[0.2em] text-muted-foreground uppercase">
              {group}
            </h3>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              {cases.map((algorithmCase) => {
                const learned = progress[algorithmCase.id] === "known";

                return (
                  <CasePreviewCard
                    algorithmCase={algorithmCase}
                    dimmed={learned}
                    key={algorithmCase.id}
                    learned={learned}
                    onClick={() => {
                      updateStatus(algorithmCase.id, learned ? "new" : "known");
                    }}
                    pressed={learned}
                    setId={setId}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
