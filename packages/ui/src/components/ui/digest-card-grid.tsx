import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export type DigestCardGridProps = {
  children: ReactNode;
  spanning?: ReactNode;
  className?: string;
};

export function DigestCardGrid({ children, spanning, className }: DigestCardGridProps) {
  return (
    <div className={cn("flex min-h-full min-w-0 flex-1 flex-col gap-3", className)}>
      <div className="grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
      {spanning == null ? null : (
        <div className="flex min-h-56 min-w-0 flex-1 flex-col">{spanning}</div>
      )}
    </div>
  );
}
