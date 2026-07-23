import { createRouter, type RouterHistory } from "@tanstack/react-router";

import { routeTree } from "@/routes/routeTree.gen";

export interface CreateAppRouterOptions {
  history?: RouterHistory;
}

export function createAppRouter(options: CreateAppRouterOptions = {}) {
  return createRouter({
    ...(options.history ? { history: options.history } : {}),
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
