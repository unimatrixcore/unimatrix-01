import { QueryClient } from "@tanstack/react-query";
import { ApiClientError, type ApiClient } from "@unimatrix/api-client";
import {
  adminDeployAttemptHistoryContract,
  adminDeployHealthHistoryContract,
} from "@unimatrix/shared";
import { describe, expect, it, vi } from "vitest";

import {
  createDeployDetailsPrefetcher,
  deployQueryKeys,
  historyQueryOptions,
} from "@/features/deploys/queries";

function pendingClient() {
  let active = 0;
  let maximum = 0;
  const reads: { app: string; path: string; resolve(): void; reject(): void }[] = [];
  const request = vi.fn(
    (contract: { path: string }, options: { query: { app: string } }) =>
      new Promise((resolve, reject) => {
        active++;
        maximum = Math.max(maximum, active);
        reads.push({
          app: options.query.app,
          path: contract.path,
          resolve() {
            active--;
            resolve({});
          },
          reject() {
            active--;
            reject(new ApiClientError("forbidden", { status: 403 }));
          },
        });
      }),
  );
  return { client: { request } as unknown as ApiClient, request, reads, maximum: () => maximum };
}

describe("deployment detail background reads", () => {
  it("limits background reads and shares an in-flight selected query", async () => {
    const queryClient = new QueryClient();
    const { client, request, reads, maximum } = pendingClient();
    const prefetcher = createDeployDetailsPrefetcher(queryClient, client);
    const complete = prefetcher.prefetch(["api", "web", "deploy"]);
    expect(request).toHaveBeenCalledTimes(2);
    const selected = queryClient.fetchQuery(historyQueryOptions(client, "api"));
    expect(request).toHaveBeenCalledTimes(2);

    reads[0]!.resolve();
    reads[1]!.resolve();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(4);
    });
    reads[2]!.resolve();
    reads[3]!.resolve();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(6);
    });
    reads[4]!.resolve();
    reads[5]!.resolve();
    await Promise.all([complete, selected]);
    expect(maximum()).toBe(2);
    expect(reads.map(({ app, path }) => [app, path])).toEqual(
      ["api", "web", "deploy"].flatMap((app) => [
        [app, adminDeployAttemptHistoryContract.path],
        [app, adminDeployHealthHistoryContract.path],
      ]),
    );
    queryClient.clear();
  });

  it("reuses fresh cache and refreshes invalidated detail data", async () => {
    const queryClient = new QueryClient();
    const request = vi.fn().mockResolvedValue({});
    const prefetcher = createDeployDetailsPrefetcher(queryClient, {
      request,
    } as unknown as ApiClient);
    await prefetcher.prefetch(["api", "web", "api", ""]);
    expect(request).toHaveBeenCalledTimes(4);
    await prefetcher.prefetch(["api", "web"]);
    expect(request).toHaveBeenCalledTimes(4);
    await queryClient.invalidateQueries({ queryKey: deployQueryKeys.all, refetchType: "none" });
    await prefetcher.prefetch(["api", "web"]);
    expect(request).toHaveBeenCalledTimes(8);
    queryClient.clear();
  });

  it("coalesces another warm request without exceeding the concurrency limit", async () => {
    const queryClient = new QueryClient();
    const { client, request, reads, maximum } = pendingClient();
    const prefetcher = createDeployDetailsPrefetcher(queryClient, client);
    const first = prefetcher.prefetch(["api"]);
    const second = prefetcher.prefetch(["api", "web"]);
    expect(second).toBe(first);
    expect(request).toHaveBeenCalledTimes(2);
    reads[0]!.resolve();
    reads[1]!.resolve();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(4);
    });
    reads[2]!.resolve();
    reads[3]!.resolve();
    await second;
    expect(maximum()).toBe(2);
    queryClient.clear();
  });

  it("continues after a detail failure and stops queued reads on cleanup", async () => {
    const queryClient = new QueryClient();
    const { client, request, reads } = pendingClient();
    const prefetcher = createDeployDetailsPrefetcher(queryClient, client);
    const complete = prefetcher.prefetch(["api", "web", "deploy"]);
    reads[0]!.reject();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(3);
    });
    prefetcher.stop();
    reads[1]!.resolve();
    reads[2]!.resolve();
    await complete;
    await prefetcher.prefetch(["deploy"]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(queryClient.getQueryState(historyQueryOptions(client, "api").queryKey)?.status).toBe(
      "error",
    );
    queryClient.clear();
  });
});
