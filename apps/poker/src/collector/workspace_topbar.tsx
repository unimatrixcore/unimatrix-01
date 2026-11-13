import type { ReactNode } from "react";
import { cn } from "@unimatrix/ui/public";
import "./workspace_topbar.css";

/** OCR Data's header geometry and control groups, shared by both workspaces. */
export function WorkspaceTopbar({
  id,
  className,
  ariaLabel,
  leading,
  actions,
}: {
  id?: string;
  className?: string;
  ariaLabel: string;
  leading: ReactNode;
  actions: ReactNode;
}) {
  return (
    <header
      id={id}
      className={cn("stepper-panel workspace-topbar", className)}
      aria-label={ariaLabel}
    >
      <div className="workspace-topbar-leading">{leading}</div>
      <div className="stepper-panel-actions">{actions}</div>
    </header>
  );
}
