import type { ReactNode } from "react";

import { ScrollArea } from "@unimatrix/ui/scroll-area";
import { Card, cn } from "@unimatrix/ui/public";

export type ToolMasterDetailProps = {
  listHeader: ReactNode;
  list: ReactNode;
  detail: ReactNode;
  className?: string;
  detailScroll?: "pane" | "managed";
  variant?: "plain" | "cards";
};

export function ToolMasterDetail({
  listHeader,
  list,
  detail,
  className,
  detailScroll = "pane",
  variant = "plain",
}: ToolMasterDetailProps) {
  const Pane = variant === "cards" ? Card : "div";
  const cardProps = variant === "cards" ? { size: "sm" as const } : {};
  return (
    <div
      className={cn(
        "grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(120px,25%)_minmax(0,1fr)] gap-4 lg:grid-cols-[15rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]",
        className,
      )}
    >
      <Pane
        {...cardProps}
        className={cn("flex min-h-0 min-w-0 flex-col", variant === "cards" && "gap-0 py-0")}
      >
        <div className="shrink-0">{listHeader}</div>
        <ScrollArea variant="overlay" className="min-h-0 min-w-0 flex-1">
          {list}
        </ScrollArea>
      </Pane>
      {detailScroll === "pane" ? (
        <ScrollArea variant="overlay" className="min-h-0 min-w-0">
          {detail}
        </ScrollArea>
      ) : (
        <Pane
          {...cardProps}
          className={cn(
            "flex min-h-0 min-w-0 flex-col overflow-hidden",
            variant === "cards" && "gap-4 px-5 py-4",
          )}
        >
          {detail}
        </Pane>
      )}
    </div>
  );
}
