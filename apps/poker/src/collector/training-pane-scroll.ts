import { useEffect, useRef } from "react";
import {
  readWorkspaceState,
  rememberWorkspaceState,
  restoreWorkspaceScroll,
} from "../lib/workspace-state";
export function useTrainingPaneScroll(key: string) {
  const ref = useRef<HTMLDivElement>(null);
  const restoring = useRef(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    restoring.current = true;
    const saved = readWorkspaceState().trainingPanes?.[key] ?? { top: 0, left: 0 };
    return restoreWorkspaceScroll(node, saved, () => {
      restoring.current = false;
    });
  }, [key]);
  return {
    ref,
    "data-training-scroll": key,
    onScroll: () => {
      if (!ref.current || restoring.current) return;
      const entries = Object.entries(readWorkspaceState().trainingPanes ?? {})
        .filter(([id]) => id !== key)
        .slice(-9);
      rememberWorkspaceState({
        trainingPanes: {
          ...Object.fromEntries(entries),
          [key]: { top: ref.current.scrollTop, left: ref.current.scrollLeft },
        },
      });
    },
  };
}
