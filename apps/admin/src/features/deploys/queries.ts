import { queryOptions, type QueryClient } from "@tanstack/react-query";
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

export interface DeployDetailsPrefetcher {
  prefetch(apps: readonly string[]): Promise<void>;
  stop(): void;
}

export function createDeployDetailsPrefetcher(
  queryClient: QueryClient,
  client: ApiClient,
): DeployDetailsPrefetcher {
  let stopped = false;
  let apps: readonly string[] = [];
  let rerun = false;
  let running: Promise<void> | null = null;

  async function warm(): Promise<void> {
    do {
      rerun = false;
      const reads = apps.flatMap((app) => [
        () => queryClient.prefetchQuery(historyQueryOptions(client, app)),
        () => queryClient.prefetchQuery(healthQueryOptions(client, app)),
      ]);
      let next = 0;
      async function worker(): Promise<void> {
        while (!stopped && next < reads.length) {
          const read = reads[next++];
          if (read !== undefined) await read();
        }
      }
      await Promise.all([worker(), worker()]);
    } while (!stopped && rerun);
  }

  return {
    prefetch(nextApps) {
      if (stopped) return Promise.resolve();
      apps = [...new Set(nextApps)].filter((app) => app.length > 0);
      rerun = true;
      running ??= warm().finally(() => {
        running = null;
      });
      return running;
    },
    stop() {
      stopped = true;
    },
  };
}
