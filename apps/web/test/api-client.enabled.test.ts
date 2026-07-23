import type { ApiClientFetch } from "@unimatrix/api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const getTokenMock = vi.fn().mockResolvedValue("test-session-token");

// Mocked so this exercises the token-wiring logic without needing a real
// Clerk `AuthProvider` (which would require network access to Clerk's
// Frontend API in a test environment).
vi.mock("@unimatrix/auth/react", () => ({
  useAuth: () => ({ getToken: getTokenMock }),
}));

// Stubbing the publishable key before each dynamic import mirrors the
// build-time condition that selects `useApiClient`'s implementation (see
// `src/lib/api-client.ts`): with a key present, it must resolve to the
// token-bearing hook.
describe("useApiClient (auth enabled)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_xxx");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    getTokenMock.mockClear();
  });

  it("attaches the Clerk session token as a bearer header, with no template argument", async () => {
    // Stubbed before the client is built (module import + hook render),
    // since `createApiClient` captures `globalThis.fetch` once, at
    // construction time.
    const fetchMock = vi.fn<ApiClientFetch>(() =>
      Promise.resolve({
        json: () => Promise.resolve({ service: "api", status: "ok" }),
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { useApiClient } = await import("../src/lib/api-client.js");
    const { result } = renderHook(() => useApiClient());

    await result.current.getHealth();

    expect(getTokenMock).toHaveBeenCalledWith();

    const call = fetchMock.mock.calls[0];

    if (!call) {
      throw new Error("Expected fetch to have been called.");
    }

    const [, init] = call;
    expect(init?.headers?.authorization).toBe("Bearer test-session-token");
  });
});
