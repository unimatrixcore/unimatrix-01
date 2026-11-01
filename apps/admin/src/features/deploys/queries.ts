import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "@unimatrix/api-client";
import {
  adminDeployStateContract,
  adminDeployAttemptHistoryContract,
  adminDeployDeclarationsContract,
  adminDeployHealthHistoryContract,
  adminDeployReconciliationContract,
} from "@unimatrix/shared";
import { retryUnlessClientError } from "@/lib/retry";

export const deployQueryKeys = { all: ["admin", "deploys"] as const };
const defaults = { staleTime: 15_000, refetchInterval: 15_000, retry: retryUnlessClientError };
export const stateQueryOptions = (client: ApiClient) =>
  queryOptions({
    ...defaults,
    queryKey: [...deployQueryKeys.all, "state"],
    queryFn: () => client.request(adminDeployStateContract, { query: {} }),
  });
export const attemptsQueryOptions = (client: ApiClient) =>
  queryOptions({
    ...defaults,
    queryKey: [...deployQueryKeys.all, "latest-attempts"],
    queryFn: () =>
      client.request(adminDeployAttemptHistoryContract, {
        query: { limit: 100, latestPerApp: "true" },
      }),
  });
export const historyQueryOptions = (client: ApiClient, app: string) =>
  queryOptions({
    ...defaults,
    enabled: app.length > 0,
    queryKey: [...deployQueryKeys.all, "attempts", app],
    queryFn: () =>
      client.request(adminDeployAttemptHistoryContract, { query: { app, limit: 100 } }),
  });
export const declarationsQueryOptions = (client: ApiClient) =>
  queryOptions({
    ...defaults,
    refetchInterval: false,
    queryKey: [...deployQueryKeys.all, "declarations"],
    queryFn: () => client.request(adminDeployDeclarationsContract, { query: {} }),
  });
export const reconciliationQueryOptions = (client: ApiClient) =>
  queryOptions({
    ...defaults,
    refetchInterval: 60_000,
    queryKey: [...deployQueryKeys.all, "reconciliation"],
    queryFn: () => client.request(adminDeployReconciliationContract, { query: {} }),
  });
export const healthQueryOptions = (client: ApiClient, app: string) =>
  queryOptions({
    ...defaults,
    queryKey: [...deployQueryKeys.all, "health", app],
    queryFn: () => client.request(adminDeployHealthHistoryContract, { query: { app } }),
  });
