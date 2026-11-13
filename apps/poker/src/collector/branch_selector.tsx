import { useEffect, useState } from "react";
import { RiGitBranchLine } from "@remixicon/react";
import {
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@unimatrix/ui";
import type { PokerLauncherStatus } from "@unimatrix/shared";
import { launcherRequest } from "../lib/launcher.js";

export function BranchSelector({ collapsed }: { collapsed: boolean }) {
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
    <div data-poker-branch-control className={collapsed ? "w-9" : "w-full min-w-0 pr-2"}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size={collapsed ? "icon" : "sm"}
            className={collapsed ? "size-9" : "w-full justify-start"}
            aria-label="Work branch"
            title={tooltip}
            disabled={!status || pending}
          >
            <RiGitBranchLine className="size-4 shrink-0" aria-hidden="true" />
            {!collapsed && <span className="truncate">{selectedLabel}</span>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" className="max-w-96">
          <DropdownMenuLabel>Work branch</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={status?.selection || "latest"}
            onValueChange={(selection) => {
              setPending(true);
              void launcherRequest("select", selection)
                .then((next) => {
                  setStatus(next);
                  setError(next.error || null);
                })
                .catch((failure: unknown) => {
                  setError(String(failure));
                })
                .finally(() => {
                  setPending(false);
                });
            }}
          >
            <DropdownMenuRadioItem value="latest">Latest commit</DropdownMenuRadioItem>
            <DropdownMenuSeparator />
            {status?.worktrees.map((tree) => (
              <DropdownMenuRadioItem key={tree.id} value={tree.id} title={tree.path}>
                {tree.branch}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && !collapsed && (
        <div className="text-xs text-destructive" role="status">
          {error}
        </div>
      )}
    </div>
  );
}
