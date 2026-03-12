import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  RiCompassDiscoverLine,
  RiLayoutGridLine,
  RiPulseLine,
  RiStackLine,
} from "@remixicon/react";

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
                  LOC-38
                </Badge>
                <Badge variant="outline">Preset aJMzyTw</Badge>
                <Badge variant="secondary">Monorepo baseline</Badge>
              </div>
              <div className="space-y-3">
                <p className="text-xs uppercase tracking-[0.32em] text-muted-foreground">
                  apps/web proof surface
                </p>
                <h1 className="max-w-4xl text-3xl leading-tight font-medium tracking-tight lg:text-5xl">
                  Shared ShadCN primitives now drive the scaffold routes from
                  `packages/ui`.
                </h1>
                <p className="max-w-3xl text-sm leading-7 text-muted-foreground lg:text-base">
                  This keeps the design-system baseline in the workspace package
                  where later public-site work can reuse it without drifting
                  back into app-local copies.
                </p>
              </div>
            </div>

            <div className="grid gap-3 self-start">
              <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
                <span>Scaffold routes</span>
                <RiStackLine aria-hidden="true" className="size-4" />
              </div>
              <nav aria-label="Scaffold navigation" className="grid gap-2">
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
              Zero-radius tokens, Geist Mono, and Remix Icons come from the
              preset instead of scaffold-only CSS.
            </p>
            <p>
              `apps/web` now consumes `@unimatrix/ui` as the proof surface for
              the shared baseline package.
            </p>
            <p>
              Route count stays unchanged while the existing overview, status,
              and not-found surfaces adopt the new system.
            </p>
          </div>
        </Card>

        <main className="grid gap-6">{children}</main>
      </div>
    </div>
  );
}
