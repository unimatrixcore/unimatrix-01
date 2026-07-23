import { describe, expect, it } from "vitest";

import {
  loadAuthAppDevProxyConfig,
  loadAuthAppRuntimeConfig,
} from "../src/lib/config.js";

describe("auth app runtime config", () => {
  it("requires a Clerk publishable key", () => {
    expect(() => loadAuthAppRuntimeConfig({})).toThrow(
      /VITE_CLERK_PUBLISHABLE_KEY is required/,
    );

    expect(() =>
      loadAuthAppRuntimeConfig({ VITE_CLERK_PUBLISHABLE_KEY: "   " }),
    ).toThrow(/VITE_CLERK_PUBLISHABLE_KEY must not be empty/);
  });

  it("loads a valid config with the default api base url", () => {
    expect(
      loadAuthAppRuntimeConfig({ VITE_CLERK_PUBLISHABLE_KEY: "pk_test_xxx" }),
    ).toEqual({
      apiBaseUrl: "/api",
      clerkPublishableKey: "pk_test_xxx",
    });
  });

  it("accepts absolute and relative api base urls", () => {
    expect(
      loadAuthAppRuntimeConfig({
        VITE_API_BASE_URL: "/api/v2",
        VITE_CLERK_PUBLISHABLE_KEY: "pk_test_xxx",
      }),
    ).toEqual({
      apiBaseUrl: "/api/v2",
      clerkPublishableKey: "pk_test_xxx",
    });

    expect(
      loadAuthAppRuntimeConfig({
        VITE_API_BASE_URL: "https://api.example.test",
        VITE_CLERK_PUBLISHABLE_KEY: "pk_test_xxx",
      }),
    ).toEqual({
      apiBaseUrl: "https://api.example.test",
      clerkPublishableKey: "pk_test_xxx",
    });
  });

  it("rejects unsupported api base url values", () => {
    expect(() =>
      loadAuthAppRuntimeConfig({
        VITE_API_BASE_URL: "api",
        VITE_CLERK_PUBLISHABLE_KEY: "pk_test_xxx",
      }),
    ).toThrow(/must be a valid http:\/\/ or https:\/\/ URL/);

    expect(() =>
      loadAuthAppRuntimeConfig({
        VITE_API_BASE_URL: "//example.test",
        VITE_CLERK_PUBLISHABLE_KEY: "pk_test_xxx",
      }),
    ).toThrow(
      /site-relative path beginning with a single \/ or a valid http:\/\/ or https:\/\/ URL/,
    );
  });

  it("uses the documented default proxy target", () => {
    expect(loadAuthAppDevProxyConfig({})).toEqual({
      apiProxyTarget: "http://127.0.0.1:3001",
    });
  });

  it("rejects invalid proxy targets", () => {
    expect(() =>
      loadAuthAppDevProxyConfig({ VITE_API_TARGET: "ws://127.0.0.1:3001" }),
    ).toThrow(/VITE_API_TARGET must be a valid http:\/\/ or https:\/\/ URL/);
  });
});
