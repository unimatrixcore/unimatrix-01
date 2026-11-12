import { usePrefetchList } from "@unimatrix/instant-list";
import { HeadContent, Link, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { RiAlertLine } from "@remixicon/react";

import { Badge, Button, Card } from "@unimatrix/ui/public";

import { useApiClient } from "@/lib/api-client";
import { adminPostsListOptions } from "@/features/content/queries";
import { AppShell } from "@/app/app-shell";
import type { AppRouterContext } from "@/app/router";
import { RequireSignedIn } from "@/app/require-signed-in";

export const Route = createRootRouteWithContext<AppRouterContext>()({
  component: RootComponent,
  head: () => ({
    meta: [{ title: "Unimatrix Admin" }],
  }),
  notFoundComponent: RootNotFound,
});

function RootComponent() {
  const { runtimeConfig } = Route.useRouteContext();
  const client = useApiClient();
  const contentIntent = usePrefetchList(adminPostsListOptions(client));

  return (
    <RequireSignedIn authAppUrl={runtimeConfig.authAppUrl} enabled={runtimeConfig.requireSignIn}>
      <AppShell contentIntent={contentIntent}>
        <HeadContent />
        <Outlet />
      </AppShell>
    </RequireSignedIn>
  );
}

function RootNotFound() {
  return (
    <Card className="w-full max-w-xl px-6 py-8">
      <div className="space-y-5">
        <Badge variant="destructive" className="gap-1.5">
          <RiAlertLine aria-hidden="true" className="size-3.5" />
          Page unavailable
        </Badge>
        <div className="space-y-3">
          <h2 className="text-2xl leading-tight font-medium tracking-[-0.05em] text-foreground">
            That page is not part of Unimatrix Admin.
          </h2>
          <p className="text-sm leading-7 text-muted-foreground">
            Head back to the console overview.
          </p>
        </div>
        <Button asChild className="w-fit">
          <Link to="/">Go to overview</Link>
        </Button>
      </div>
    </Card>
  );
}
