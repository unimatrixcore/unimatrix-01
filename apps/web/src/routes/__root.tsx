import {
  Link,
  Outlet,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { RiAlertLine } from "@remixicon/react";

import { Badge, Button, Card } from "@unimatrix/ui";
import { AppShell } from "@/app/app-shell";
import type { AppRouterContext } from "@/app/router";

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
    <Card className="border-border/60 bg-card/94 shadow-[0_18px_60px_-36px_color-mix(in_oklab,var(--foreground)_22%,transparent)]">
      <div className="space-y-4 px-6">
        <Badge variant="destructive" className="gap-1.5">
          <RiAlertLine aria-hidden="true" className="size-3.5" />
          Not found
        </Badge>
        <div className="space-y-3">
          <h2 className="text-2xl leading-tight font-medium tracking-tight">
            This site currently defines overview, projects, blog, and status routes.
          </h2>
          <p className="max-w-2xl text-sm leading-7 text-muted-foreground lg:text-base">
            The page you're looking for doesn't exist. Try navigating to one of the
            sections above.
          </p>
        </div>
        <Button asChild className="w-fit">
          <Link to="/">Return to overview</Link>
        </Button>
      </div>
    </Card>
  );
}
