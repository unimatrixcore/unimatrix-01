import type * as React from "react";

import { cn } from "@unimatrix/ui/public";

export function AppPageContainer({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative mx-auto flex min-h-[100dvh] w-full max-w-5xl flex-col gap-8 px-4 py-4 sm:px-6 lg:gap-10 lg:px-8 lg:py-6",
        className,
      )}
      {...props}
    />
  );
}

export function AppFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="py-1">
      <p className="text-xs text-muted-foreground/70">
        ©{" "}
        <a
          className="underline decoration-muted-foreground/35 underline-offset-4 transition-colors hover:text-foreground"
          href="https://unimatrix-01.dev/"
          rel="noreferrer"
          target="_blank"
        >
          {year} Gwen Phalan
        </a>
        . Algorithm data from{" "}
        <a
          className="underline decoration-muted-foreground/35 underline-offset-4 transition-colors hover:text-foreground"
          href="https://jperm.net/algs"
          rel="noreferrer"
          target="_blank"
        >
          jperm.net/algs
        </a>
      </p>
    </footer>
  );
}
