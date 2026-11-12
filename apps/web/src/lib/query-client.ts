import type { QueryClient } from "@tanstack/react-query";
import { createInstantQueryClient } from "@unimatrix/instant-list";

export function createAppQueryClient(): QueryClient {
  return createInstantQueryClient();
}

export const queryClient = createAppQueryClient();
