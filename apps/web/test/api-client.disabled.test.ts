import type { ApiClientFetch } from "@unimatrix/api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

// No VITE_CLERK_PUBLISHABLE_KEY is stubbed in this file, so importing
// `@/lib/api-client` mirrors the default, auth-disabled build: `useApiClient`
// must resolve to the tokenless singleton and must never call Clerk's
// `useAuth()` (there is no `AuthProvider` mounted to satisfy it).
//
// `apiClient` is created once, at module scope, from whatever `fetch` is on
// `globalThis` at import time — so each test resets modules and stubs
// `fetch` *before* importing, to make sure the module-scoped client is
// actually built against that test's mock.
describe("useApiClient (auth disabled)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves to the shared tokenless api client singleton with no provider mounted", async () => {
    const { apiClient, useApiClient } = await import("../src/lib/api-client.js");

    const { result } = renderHook(() => useApiClient());

    expect(result.current).toBe(apiClient);
  });

  it("sends public requests with no authorization header", async () => {
    const fetchMock = vi.fn<ApiClientFetch>(() =>
      Promise.resolve({
        json: () => Promise.resolve({ service: "api", status: "ok" }),
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiClient } = await import("../src/lib/api-client.js");

    await apiClient.getHealth();

    const call = fetchMock.mock.calls[0];

    if (!call) {
      throw new Error("Expected fetch to have been called.");
    }

    const [, init] = call;
    expect(init?.headers?.authorization).toBeUndefined();
  });
});
