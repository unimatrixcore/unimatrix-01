import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";

import { AppShell } from "@/app/app-shell";
import type { AppRouterContext } from "@/app/router";
import { Surface } from "@/components/surface";

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
    <Surface>
      <p className="eyebrow">Not found</p>
      <h2>Unknown route</h2>
      <p className="body-copy">
        This scaffold only defines the overview and status routes right now.
      </p>
    </Surface>
  );
}
