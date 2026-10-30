import type { ReactElement } from "react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip.js";

export interface ActionTooltipProps {
  children: ReactElement;
  label: string;
}

export function ActionTooltip({ children, label }: ActionTooltipProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
