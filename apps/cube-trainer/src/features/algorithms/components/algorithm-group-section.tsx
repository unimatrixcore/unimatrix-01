import { AlgorithmCaseCard } from "@/features/algorithms/components/algorithm-case-card";
import type { AlgorithmCase } from "@/features/algorithms/types";
import type { CaseProgress, CaseStatus } from "@/lib/progress-storage";

export function AlgorithmGroupSection({
  cases,
  group,
  onStatusChange,
  progress,
}: {
  cases: AlgorithmCase[];
  group: string;
  onStatusChange: (caseId: string, status: CaseStatus) => void;
  progress: CaseProgress;
}) {
  if (cases.length === 0) {
    return null;
  }

  return (
    <section className="space-y-3">
      <h3 className="text-xs font-medium tracking-[0.2em] text-muted-foreground uppercase">
        {group}
      </h3>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cases.map((algorithmCase) => (
          <AlgorithmCaseCard
            algorithmCase={algorithmCase}
            key={algorithmCase.id}
            onStatusChange={(status) => {
              onStatusChange(algorithmCase.id, status);
            }}
            status={progress[algorithmCase.id] ?? "new"}
          />
        ))}
      </div>
    </section>
  );
}
