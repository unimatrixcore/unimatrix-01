import type { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";

import { queryClient } from "@/lib/query-client";
import { routeTree } from "@/routes/routeTree.gen";

export type AppRouterContext = {
  queryClient: QueryClient;
};

export const router = createRouter({
  context: {
    queryClient,
  } satisfies AppRouterContext,
  routeTree,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
