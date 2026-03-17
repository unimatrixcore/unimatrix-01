import { queryOptions } from "@tanstack/react-query";

import { apiClient } from "@/lib/api-client";

const ROUTER_STATUS_MESSAGE = "TanStack Router file-based routing is active.";
const SUCCESS_CLIENT_STATUS_MESSAGE =
  "GET /health is fetched through @unimatrix/api-client and parsed with the shared contract.";
const FALLBACK_SERVICE = "api";
const FALLBACK_STATUS = "unavailable";

export interface StatusSnapshot {
  checkedAt: string;
  clientStatus: string;
  routerStatus: string;
  service: string;
  status: string;
}

async function getStatusSnapshot(): Promise<StatusSnapshot> {
  const checkedAt = new Date().toLocaleTimeString();

  try {
    const health = await apiClient.getHealth();

    return {
      checkedAt,
      clientStatus: SUCCESS_CLIENT_STATUS_MESSAGE,
      routerStatus: ROUTER_STATUS_MESSAGE,
      service: health.service,
      status: health.status,
    };
  } catch (error) {
    return {
      checkedAt,
      clientStatus:
        error instanceof Error
          ? `GET /health could not be loaded: ${error.message}`
          : "GET /health could not be loaded.",
      routerStatus: ROUTER_STATUS_MESSAGE,
      service: FALLBACK_SERVICE,
      status: FALLBACK_STATUS,
    };
  }
}

export function statusSnapshotQueryOptions() {
  return queryOptions({
    queryFn: getStatusSnapshot,
    queryKey: ["status-snapshot"],
    staleTime: 1000 * 60,
  });
}
