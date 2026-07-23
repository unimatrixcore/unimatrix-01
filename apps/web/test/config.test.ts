import { describe, expect, it } from "vitest";

import {
  isAuthEnabled,
  loadWebDevProxyConfig,
  loadWebRuntimeConfig,
} from "../src/lib/config.js";

describe("web runtime config", () => {
  it("uses the default relative api base url and auth app url, with auth disabled", () => {
    expect(loadWebRuntimeConfig({})).toEqual({
      apiBaseUrl: "/api",
      authAppUrl: "https://auth.unimatrix-01.dev",
    });
  });

  it("accepts absolute and relative api base urls", () => {
    expect(loadWebRuntimeConfig({ VITE_API_BASE_URL: "/api/v2" })).toEqual({
      apiBaseUrl: "/api/v2",
      authAppUrl: "https://auth.unimatrix-01.dev",
    });

    expect(
      loadWebRuntimeConfig({ VITE_API_BASE_URL: "https://api.example.test" }),
    ).toEqual({
      apiBaseUrl: "https://api.example.test",
      authAppUrl: "https://auth.unimatrix-01.dev",
    });
  });

  it("rejects unsupported api base url values", () => {
    expect(() => loadWebRuntimeConfig({ VITE_API_BASE_URL: "api" })).toThrow(
      /must be a valid http:\/\/ or https:\/\/ URL/,
    );
    expect(() =>
      loadWebRuntimeConfig({ VITE_API_BASE_URL: "//example.test" }),
    ).toThrow(
      /site-relative path beginning with a single \/ or a valid http:\/\/ or https:\/\/ URL/,
    );
  });

  it("uses the documented default proxy target", () => {
    expect(loadWebDevProxyConfig({})).toEqual({
      apiProxyTarget: "http://127.0.0.1:3001",
    });
  });

  it("rejects invalid proxy targets", () => {
    expect(() =>
      loadWebDevProxyConfig({ VITE_API_TARGET: "ws://127.0.0.1:3001" }),
    ).toThrow(/VITE_API_TARGET must be a valid http:\/\/ or https:\/\/ URL/);
  });

  it("leaves the Clerk publishable key undefined when unset", () => {
    const config = loadWebRuntimeConfig({});

    expect(config.clerkPublishableKey).toBeUndefined();
    expect(isAuthEnabled(config)).toBe(false);
  });

  it("accepts a non-empty Clerk publishable key and enables auth", () => {
    const config = loadWebRuntimeConfig({
      VITE_CLERK_PUBLISHABLE_KEY: "pk_test_xxx",
    });

    expect(config).toEqual({
      apiBaseUrl: "/api",
      authAppUrl: "https://auth.unimatrix-01.dev",
      clerkPublishableKey: "pk_test_xxx",
    });
    expect(isAuthEnabled(config)).toBe(true);
  });

  it("rejects a Clerk publishable key that is present but empty", () => {
    expect(() =>
      loadWebRuntimeConfig({ VITE_CLERK_PUBLISHABLE_KEY: "   " }),
    ).toThrow(/VITE_CLERK_PUBLISHABLE_KEY must not be empty/);
  });

  it("uses the documented default auth app url", () => {
    expect(loadWebRuntimeConfig({}).authAppUrl).toBe(
      "https://auth.unimatrix-01.dev",
    );
  });

  it("accepts a custom auth app url", () => {
    expect(
      loadWebRuntimeConfig({ VITE_AUTH_APP_URL: "https://auth.example.test" }),
    ).toEqual({
      apiBaseUrl: "/api",
      authAppUrl: "https://auth.example.test",
    });
  });

  it("rejects an invalid auth app url", () => {
    expect(() =>
      loadWebRuntimeConfig({ VITE_AUTH_APP_URL: "not-a-url" }),
    ).toThrow(/VITE_AUTH_APP_URL must be a valid http:\/\/ or https:\/\/ URL/);
  });
});
