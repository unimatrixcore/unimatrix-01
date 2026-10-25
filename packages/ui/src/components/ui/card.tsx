import * as React from "react";

import { cn } from "../../lib/utils.js";

export type CardHeight = "content" | "summary" | "fill";

export type CardProps = React.ComponentProps<"div"> & {
  size?: "default" | "sm";
  height?: CardHeight;
};

function Card({ className, size = "default", height = "content", ...props }: CardProps) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "group/card flex flex-col overflow-hidden rounded-xl bg-card text-sm text-card-foreground shadow-xs ring-1 ring-foreground/10 has-[>img:first-child]:pt-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        size === "sm"
          ? "gap-4 py-4 [--card-section-padding:--spacing(4)] [--card-title-size:var(--text-sm)]"
          : "gap-6 py-6",
        height === "summary" && "h-48 shrink-0",
        height === "fill" && "min-h-0 flex-1",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-[var(--card-section-padding,--spacing(6))] has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [:where(&.border-b)]:pb-[var(--card-section-padding,--spacing(6))]",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "text-[length:var(--card-title-size,var(--text-base))] leading-normal font-medium",
        className,
      )}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-[var(--card-section-padding,--spacing(6))]", className)}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-xl px-[var(--card-section-padding,--spacing(6))] [:where(&.border-t)]:pt-[var(--card-section-padding,--spacing(6))]",
        className,
      )}
      {...props}
    />
  );
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent };
