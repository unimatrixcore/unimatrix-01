import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "@unimatrix/api-client";

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

export async function getStatusSnapshot(apiClient: ApiClient): Promise<StatusSnapshot> {
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

/**
 * Not currently wired to a route — kept as the reference example for
 * fetching `GET /health` through `@unimatrix/api-client`. Callers should
 * pass the client returned by `useApiClient()` (token-bearing when auth is
 * enabled) rather than reaching for a client directly, so there is a single
 * clear way to obtain one.
 */
export function statusSnapshotQueryOptions(apiClient: ApiClient) {
  return queryOptions({
    queryFn: () => getStatusSnapshot(apiClient),
    queryKey: ["status-snapshot"],
    staleTime: 1000 * 60,
  });
}
