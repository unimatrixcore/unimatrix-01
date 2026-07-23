import {
  HeadContent,
  Link,
  Outlet,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { RiAlertLine } from "@remixicon/react";

import { AppShell } from "@/app/app-shell";
import type { AppRouterContext } from "@/app/router";
import { Badge, Button, Card } from "@unimatrix/ui/public";

export const Route = createRootRouteWithContext<AppRouterContext>()({
  component: RootComponent,
  head: () => ({
    meta: [{ title: "Unimatrix Accounts" }],
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
    <Card className="w-full max-w-md px-6 py-8">
      <div className="space-y-5">
        <Badge variant="destructive" className="gap-1.5">
          <RiAlertLine aria-hidden="true" className="size-3.5" />
          Page unavailable
        </Badge>
        <div className="space-y-3">
          <h2 className="text-2xl leading-tight font-medium tracking-[-0.05em] text-foreground">
            That page is not part of Unimatrix Accounts.
          </h2>
          <p className="text-sm leading-7 text-muted-foreground">
            Head back to sign in or manage your account.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button asChild className="w-fit">
            <Link to="/">Go home</Link>
          </Button>
          <Button asChild variant="outline" className="w-fit">
            <Link to="/account">Manage account</Link>
          </Button>
        </div>
      </div>
    </Card>
  );
}
