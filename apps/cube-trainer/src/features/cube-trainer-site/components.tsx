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
        © {year} Gwen Phalan. Algorithm data from{" "}
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

export function SectionHeading({
  badges,
  className,
  description,
  title,
  trailing,
}: {
  badges?: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  title?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid gap-3 border-b border-border/70 pb-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end",
        className,
      )}
    >
      <div className="space-y-3">
        {badges ? <div className="flex flex-wrap items-center gap-2">{badges}</div> : null}
        {title ? (
          <h2 className="max-w-5xl text-2xl leading-[0.96] font-medium tracking-[-0.05em] text-foreground lg:text-3xl">
            {title}
          </h2>
        ) : null}
        {description ? (
          <p className="max-w-3xl text-sm leading-7 text-muted-foreground lg:text-[0.95rem] lg:leading-7">
            {description}
          </p>
        ) : null}
      </div>

      {trailing ? <div className="flex items-end justify-end">{trailing}</div> : null}
    </div>
  );
}
