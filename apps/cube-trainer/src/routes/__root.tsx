import { HeadContent, Link, Outlet, createRootRoute } from "@tanstack/react-router";
import { RiAlertLine } from "@remixicon/react";

import { AppShell } from "@/app/app-shell";
import { Badge, Button, Card } from "@unimatrix/ui/public";

export const Route = createRootRoute({
  component: RootComponent,
  head: () => ({
    meta: [{ title: "Cube Trainer" }],
  }),
  notFoundComponent: RootNotFound,
});

function RootComponent() {
  return (
    <AppShell>
      <HeadContent />
      <Outlet />
    </AppShell>
  );
}

function RootNotFound() {
  return (
    <Card className="site-panel site-panel-strong max-w-3xl px-6 py-6 lg:px-8 lg:py-8">
      <div className="space-y-5">
        <Badge variant="destructive" className="gap-1.5">
          <RiAlertLine aria-hidden="true" className="size-3.5" />
          Page unavailable
        </Badge>
        <div className="space-y-3">
          <h2 className="text-3xl leading-tight font-medium tracking-[-0.05em] text-foreground">
            That page is not part of Cube Trainer.
          </h2>
          <p className="max-w-2xl text-sm leading-7 text-muted-foreground lg:text-base lg:leading-8">
            Return home or jump straight to OLL or PLL training.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button asChild className="w-fit">
            <Link to="/">Go home</Link>
          </Button>
          <Button asChild variant="outline" className="w-fit">
            <Link to="/oll">Train OLL</Link>
          </Button>
          <Button asChild variant="secondary" className="w-fit">
            <Link to="/pll">Train PLL</Link>
          </Button>
        </div>
      </div>
    </Card>
  );
}
