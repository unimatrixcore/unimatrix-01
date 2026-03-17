import { describe, expect, it } from "vitest";

import {
  loadWebDevProxyConfig,
  loadWebRuntimeConfig,
} from "../src/lib/config.js";

describe("web runtime config", () => {
  it("uses the default relative api base url", () => {
    expect(loadWebRuntimeConfig({})).toEqual({
      apiBaseUrl: "/api",
    });
  });

  it("accepts absolute and relative api base urls", () => {
    expect(loadWebRuntimeConfig({ VITE_API_BASE_URL: "/api/v2" })).toEqual({
      apiBaseUrl: "/api/v2",
    });

    expect(
      loadWebRuntimeConfig({ VITE_API_BASE_URL: "https://api.example.test" }),
    ).toEqual({
      apiBaseUrl: "https://api.example.test",
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
});
