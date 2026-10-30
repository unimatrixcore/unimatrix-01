import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export type DigestRowListProps = ComponentProps<"ul">;

export function DigestRowList({ className, ...props }: DigestRowListProps) {
  return (
    <ul
      className={cn("-mx-[var(--card-section-padding,--spacing(6))] list-none p-0", className)}
      {...props}
    />
  );
}

export type DigestRowProps = {
  indicator?: ReactNode;
  itemKey: ReactNode;
  description: string;
  state?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  className?: string;
};

export function DigestRow({
  indicator,
  itemKey,
  description,
  state,
  meta,
  action,
  className,
}: DigestRowProps) {
  return (
    <li
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-[var(--card-section-padding,--spacing(6))] py-2 last:border-b-0",
        className,
      )}
    >
      {indicator}
      <span className="shrink-0 font-mono text-xs">{itemKey}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={description}>
        {description}
      </span>
      {state == null && meta == null ? null : (
        <span className="order-last flex w-full items-center gap-3 text-xs sm:order-none sm:w-auto">
          {state}
          {meta == null ? null : <span className="text-muted-foreground">{meta}</span>}
        </span>
      )}
      {action == null ? null : <span className="shrink-0">{action}</span>}
    </li>
  );
}
