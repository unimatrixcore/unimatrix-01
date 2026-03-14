import { queryOptions } from "@tanstack/react-query";

import { apiClient } from "@/lib/api-client";

type HealthStatus = Awaited<ReturnType<typeof apiClient.getHealth>>;

export interface ScaffoldStatus extends HealthStatus {
  checkedAt: string;
  clientStatus: string;
  routerStatus: string;
}

async function getScaffoldStatus(): Promise<ScaffoldStatus> {
  const health = await apiClient.getHealth();

  return {
    checkedAt: new Date().toLocaleTimeString(),
    clientStatus:
      "GET /health is fetched through @unimatrix/api-client and parsed with the shared contract.",
    routerStatus: "TanStack Router file-based routing is active.",
    service: health.service,
    status: health.status,
  };
}

export function scaffoldStatusQueryOptions() {
  return queryOptions({
    queryFn: getScaffoldStatus,
    queryKey: ["scaffold-status"],
    staleTime: 1000 * 60,
  });
}
