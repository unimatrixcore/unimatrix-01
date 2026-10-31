import { HeadContent, Outlet, createRootRouteWithContext } from "@tanstack/react-router";

import type { AppRouterContext } from "@/app/router";

export const Route = createRootRouteWithContext<AppRouterContext>()({
  component: RootComponent,
});

function RootComponent() {
  return (
    <>
      <HeadContent />
      <Outlet />
    </>
  );
}
