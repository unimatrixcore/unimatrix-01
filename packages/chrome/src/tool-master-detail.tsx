import type { ReactNode } from "react";

import { ScrollArea } from "@unimatrix/ui/scroll-area";
import { cn } from "@unimatrix/ui/public";

export type ToolMasterDetailProps = {
  listHeader: ReactNode;
  list: ReactNode;
  detail: ReactNode;
  className?: string;
  detailScroll?: "pane" | "managed";
};

export function ToolMasterDetail({
  listHeader,
  list,
  detail,
  className,
  detailScroll = "pane",
}: ToolMasterDetailProps) {
  return (
    <div
      className={cn(
        "grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(120px,25%)_minmax(0,1fr)] gap-4 lg:grid-cols-[15rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]",
        className,
      )}
    >
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="shrink-0">{listHeader}</div>
        <ScrollArea variant="overlay" className="min-h-0 min-w-0 flex-1">
          {list}
        </ScrollArea>
      </div>
      {detailScroll === "pane" ? (
        <ScrollArea variant="overlay" className="min-h-0 min-w-0">
          {detail}
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">{detail}</div>
      )}
    </div>
  );
}
