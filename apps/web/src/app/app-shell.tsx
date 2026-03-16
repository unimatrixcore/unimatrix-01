import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  RiCompassDiscoverLine,
  RiLayoutGridLine,
  RiPulseLine,
  RiStackLine,
} from "@remixicon/react";

import { homeContent } from "@/features/content/site-content";
import { Badge, Button, Card, Separator, cn } from "@unimatrix/ui";

type AppShellProps = {
  children: ReactNode;
};

const navItems = [
  {
    exact: true,
    icon: RiCompassDiscoverLine,
    label: "Overview",
    to: "/" as const,
  },
  {
    exact: false,
    icon: RiLayoutGridLine,
    label: "Projects",
    to: "/projects" as const,
  },
  {
    exact: false,
    icon: RiStackLine,
    label: "Blog",
    to: "/blog" as const,
  },
  {
    exact: false,
    icon: RiPulseLine,
    label: "Status",
    to: "/status" as const,
  },
];

export function AppShell({ children }: AppShellProps) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
    <div className="min-h-screen">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-6 py-6 lg:px-10 lg:py-8">
        <Card className="border-border/60 bg-card/88 shadow-[0_28px_100px_-44px_color-mix(in_oklab,var(--foreground)_28%,transparent)] backdrop-blur">
          <div className="grid gap-6 px-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="gap-1.5">
                  <RiLayoutGridLine aria-hidden="true" className="size-3.5" />
                  Public v1
                </Badge>
                <Badge variant="outline">Repo-backed content</Badge>
                <Badge variant="secondary">Safe markdown</Badge>
              </div>
              <div className="space-y-3">
                <p className="text-xs uppercase tracking-[0.32em] text-muted-foreground">
                  public-site content surface
                </p>
                <h1 className="max-w-4xl text-3xl leading-tight font-medium tracking-tight lg:text-5xl">
                  {homeContent.frontmatter.title}
                </h1>
                <p className="max-w-3xl text-sm leading-7 text-muted-foreground lg:text-base">
                  {homeContent.frontmatter.intro}
                </p>
              </div>
            </div>

            <div className="grid gap-3 self-start">
              <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
                <span>Content routes</span>
                <RiStackLine aria-hidden="true" className="size-4" />
              </div>
              <nav aria-label="Site navigation" className="grid gap-2">
                {navItems.map(({ exact, icon: Icon, label, to }) => {
                  const isActive = exact
                    ? pathname === to
                    : pathname.startsWith(to);

                  return (
                    <Button
                      key={to}
                      asChild
                      className={cn(
                        "w-full justify-start gap-2 shadow-none",
                        !isActive && "bg-card/70",
                      )}
                      variant={isActive ? "default" : "outline"}
                    >
                      <Link to={to}>
                        <Icon aria-hidden="true" className="size-4" />
                        {label}
                      </Link>
                    </Button>
                  );
                })}
              </nav>
            </div>
          </div>

          <Separator className="mt-6" />

          <div className="grid gap-3 px-6 text-xs leading-6 text-muted-foreground lg:grid-cols-3">
            <p>
              Projects and writing stay repo-backed so the public surface remains
              easy to inspect, review, and evolve.
            </p>
            <p>
              The web app uses shared content contracts and shared UI primitives
              from the monorepo instead of route-local placeholders.
            </p>
            <p>
              The first public release keeps markdown intentionally plain and
              non-executable while richer content tooling stays future work.
            </p>
          </div>
        </Card>

        <main className="grid gap-6">{children}</main>
      </div>
    </div>
  );
}
