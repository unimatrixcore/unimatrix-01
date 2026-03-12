import type * as React from "react";

import { cn } from "../../lib/utils.js";

export function Card({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      data-size={size}
      data-slot="card"
      className={cn(
        "group/card flex flex-col gap-6 overflow-hidden bg-card py-6 text-sm text-card-foreground shadow-xs ring-1 ring-foreground/10 data-[size=sm]:gap-4 data-[size=sm]:py-4",
        className,
      )}
      {...props}
    />
  );
}
