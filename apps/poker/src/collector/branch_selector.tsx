import { useEffect, useState } from "react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@unimatrix/ui";
import type { PokerLauncherStatus } from "@unimatrix/shared";
import { launcherRequest } from "../lib/launcher.js";

export function BranchSelector() {
  const [status, setStatus] = useState<PokerLauncherStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await launcherRequest("status");
        if (active) {
          setStatus(next);
          setError(next.error || null);
        }
      } catch (failure) {
        if (active) setError(String(failure));
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const branch = status?.current?.branch || "Starting Poker Lab";
  const tooltip = `${branch}${status?.desired && status.desired.id !== status.current?.id ? ` → ${status.desired.branch}` : ""}${error ? `: ${error}` : ""}`;
  const selectedLabel =
    status?.selection === "latest" || !status
      ? "Latest commit"
      : status.worktrees.find((tree) => tree.id === status.selection)?.branch ||
        "Work branch unavailable";
  return (
    <div data-poker-branch-control className="w-full min-w-0">
      <Select
        value={status?.selection || "latest"}
        disabled={!status || pending}
        onValueChange={(selection) => {
          setPending(true);
          void launcherRequest("select", selection)
            .then((next) => {
              setStatus(next);
              setError(next.error || null);
            })
            .catch((reason: unknown) => {
              setError(String(reason));
            })
            .finally(() => {
              setPending(false);
            });
        }}
      >
        <SelectTrigger aria-label="Checkout" title={tooltip}>
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start" className="app-settings-select-menu">
          <SelectItem value="latest">Latest commit</SelectItem>
          {status?.worktrees.map((tree) => (
            <SelectItem key={tree.id} value={tree.id} title={tree.path}>
              {tree.branch}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && (
        <div className="text-xs text-destructive" role="status">
          {error}
        </div>
      )}
    </div>
  );
}
