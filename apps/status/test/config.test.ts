import { describe, expect, it } from "vitest";

import { loadStatusDevProxyConfig, loadStatusRuntimeConfig } from "@/lib/config";

describe("status configuration", () => {
  it("uses the local API path by default and accepts an explicit public API origin", () => {
    expect(loadStatusRuntimeConfig({})).toEqual({ apiBaseUrl: "/api" });
    expect(loadStatusRuntimeConfig({ VITE_API_BASE_URL: "https://api.unimatrix-01.dev" })).toEqual({
      apiBaseUrl: "https://api.unimatrix-01.dev",
    });
  });
  it("rejects non-HTTP API configuration", () => {
    expect(() => loadStatusRuntimeConfig({ VITE_API_BASE_URL: "javascript:alert(1)" })).toThrow();
  });
  it("validates the local dev proxy target", () => {
    expect(loadStatusDevProxyConfig({})).toEqual({ apiProxyTarget: "http://127.0.0.1:3001" });
    expect(loadStatusDevProxyConfig({ VITE_API_TARGET: "http://localhost:3002" })).toEqual({
      apiProxyTarget: "http://localhost:3002",
    });
    expect(() => loadStatusDevProxyConfig({ VITE_API_TARGET: "invalid" })).toThrow();
  });
});
