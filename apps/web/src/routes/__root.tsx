import {
  Link,
  Outlet,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { RiAlertLine } from "@remixicon/react";

import { AppShell } from "@/app/app-shell";
import type { AppRouterContext } from "@/app/router";
import { Badge, Button, Card } from "@unimatrix/ui";

export const Route = createRootRouteWithContext<AppRouterContext>()({
  component: RootComponent,
  notFoundComponent: RootNotFound,
});

function RootComponent() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

function RootNotFound() {
  return (
    <Card className="border border-border/70 bg-background/56 shadow-[0_32px_120px_-76px_color-mix(in_oklab,var(--foreground)_72%,transparent)] backdrop-blur-xl">
      <div className="space-y-5 px-6">
        <Badge variant="destructive" className="gap-1.5">
          <RiAlertLine aria-hidden="true" className="size-3.5" />
          Route offline
        </Badge>
        <div className="space-y-3">
          <h2 className="text-2xl leading-tight font-medium tracking-[-0.04em]">
            That page is not part of the current public site.
          </h2>
          <p className="max-w-2xl text-sm leading-7 text-muted-foreground lg:text-base">
            Try returning to the overview or move into projects, blog, or status from the route
            deck above.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button asChild className="w-fit">
            <Link to="/">Return to overview</Link>
          </Button>
          <Button asChild variant="outline" className="w-fit">
            <Link to="/projects">Open projects</Link>
          </Button>
          <Button asChild variant="secondary" className="w-fit">
            <Link to="/blog">Open blog</Link>
          </Button>
        </div>
      </div>
    </Card>
  );
}
