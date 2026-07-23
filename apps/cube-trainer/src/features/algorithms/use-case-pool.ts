import { useCallback, useState } from "react";

import type { AlgorithmSetId } from "@/features/algorithms/types";
import { type CasePool, readCasePool, setCaseEnabled } from "@/lib/pool-storage";

export interface UseCasePoolResult {
  pool: CasePool;
  setEnabled: (caseId: string, enabled: boolean) => void;
}

export function useCasePool(setId: AlgorithmSetId): UseCasePoolResult {
  const [pool, setPool] = useState<CasePool>(() => readCasePool(setId));

  const setEnabled = useCallback(
    (caseId: string, enabled: boolean) => {
      setPool(setCaseEnabled(setId, caseId, enabled));
    },
    [setId],
  );

  return { pool, setEnabled };
}
