import type { ApiClient } from "@unimatrix/api-client";
import { describe, expect, it, vi } from "vitest";

import {
  getStatusSnapshot,
  statusSnapshotQueryOptions,
} from "@/features/status/queries/get-status-snapshot";

function createMockApiClient(getHealth: ApiClient["getHealth"]): ApiClient {
  return {
    getHealth,
    listUsers: vi.fn(),
    request: vi.fn(),
    updateUserPermissions: vi.fn(),
  } as unknown as ApiClient;
}

describe("getStatusSnapshot", () => {
  it("reports the health check result from the given api client", async () => {
    const client = createMockApiClient(() =>
      Promise.resolve({ service: "api", status: "ok" }),
    );

    const snapshot = await getStatusSnapshot(client);

    expect(snapshot.service).toBe("api");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.clientStatus).toMatch(/GET \/health is fetched/);
  });

  it("falls back to an unavailable snapshot when the api client rejects", async () => {
    const client = createMockApiClient(() =>
      Promise.reject(new Error("network unreachable")),
    );

    const snapshot = await getStatusSnapshot(client);

    expect(snapshot.service).toBe("api");
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.clientStatus).toMatch(/network unreachable/);
  });
});

describe("statusSnapshotQueryOptions", () => {
  it("builds query options that call getHealth on the given client", async () => {
    const getHealth = vi.fn(
      (): Promise<{ service: "api"; status: "ok" }> =>
        Promise.resolve({ service: "api", status: "ok" }),
    );
    const client = createMockApiClient(getHealth);

    const options = statusSnapshotQueryOptions(client);
    const { queryFn } = options;

    if (!queryFn) {
      throw new Error("Expected statusSnapshotQueryOptions to define a queryFn.");
    }

    const context = {} as Parameters<typeof queryFn>[0];
    const snapshot = await queryFn(context);

    expect(getHealth).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({ service: "api", status: "ok" });
    expect(options.queryKey).toEqual(["status-snapshot"]);
  });
});
