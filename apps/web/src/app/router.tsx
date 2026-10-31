import type { QueryClient } from "@tanstack/react-query";
import { createRouter, type RouterHistory } from "@tanstack/react-router";

import { queryClient } from "@/lib/query-client";
import { routeTree } from "@/routes/routeTree.gen";

export type AppRouterContext = {
  queryClient: QueryClient;
  hostname: string;
};

export interface CreateAppRouterOptions {
  history?: RouterHistory;
  queryClient?: QueryClient;
  hostname?: string;
}

export function createAppRouter(options: CreateAppRouterOptions = {}) {
  return createRouter({
    ...(options.history ? { history: options.history } : {}),
    context: {
      queryClient: options.queryClient ?? queryClient,
      hostname: options.hostname ?? (typeof window === "undefined" ? "" : window.location.hostname),
    } satisfies AppRouterContext,
    routeTree,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

export const router: AppRouter = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
