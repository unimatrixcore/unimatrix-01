import { queryOptions } from "@tanstack/react-query";
import { publicDeploymentStatusContract } from "@unimatrix/shared";

import { apiClient } from "@/lib/api-client";

export function publicStatusQueryOptions() {
  return queryOptions({
    queryKey: ["public-deployment-status"],
    queryFn: () => apiClient.request(publicDeploymentStatusContract, { query: {} }),
    staleTime: 15_000,
    refetchInterval: 60_000,
    retry: false,
    retryOnMount: false,
  });
}
