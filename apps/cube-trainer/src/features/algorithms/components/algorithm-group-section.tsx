import { CasePreviewCard } from "@/features/algorithms/components/case-preview-card";
import type { AlgorithmCase, AlgorithmSetId } from "@/features/algorithms/types";
import type { CasePool } from "@/lib/pool-storage";
import { isCaseEnabled } from "@/lib/pool-storage";

export function AlgorithmGroupSection({
  cases,
  group,
  onEnabledChange,
  pool,
  setId,
}: {
  cases: AlgorithmCase[];
  group: string;
  onEnabledChange: (caseId: string, enabled: boolean) => void;
  pool: CasePool;
  setId: AlgorithmSetId;
}) {
  if (cases.length === 0) {
    return null;
  }

  return (
    <section className="space-y-3">
      <h3 className="text-xs font-medium tracking-[0.2em] text-muted-foreground uppercase">
        {group}
      </h3>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {cases.map((algorithmCase) => {
          const enabled = isCaseEnabled(pool, algorithmCase.id);

          return (
            <CasePreviewCard
              algorithmCase={algorithmCase}
              dimmed={!enabled}
              key={algorithmCase.id}
              onClick={() => {
                onEnabledChange(algorithmCase.id, !enabled);
              }}
              pressed={enabled}
              setId={setId}
            />
          );
        })}
      </div>
    </section>
  );
}
