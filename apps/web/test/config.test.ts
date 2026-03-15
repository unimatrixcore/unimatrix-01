import assert from "node:assert/strict";
import test from "node:test";

import {
  loadWebDevProxyConfig,
  loadWebRuntimeConfig,
} from "../src/lib/config.js";

void test("loadWebRuntimeConfig uses the default relative api base url", () => {
  assert.deepEqual(loadWebRuntimeConfig({}), {
    apiBaseUrl: "/api",
  });
});

void test("loadWebRuntimeConfig accepts absolute and relative api base urls", () => {
  assert.deepEqual(loadWebRuntimeConfig({ VITE_API_BASE_URL: "/api/v2" }), {
    apiBaseUrl: "/api/v2",
  });

  assert.deepEqual(
    loadWebRuntimeConfig({ VITE_API_BASE_URL: "https://api.example.test" }),
    {
      apiBaseUrl: "https://api.example.test",
    },
  );
});

void test("loadWebRuntimeConfig rejects unsupported api base url values", () => {
  assert.throws(
    () => loadWebRuntimeConfig({ VITE_API_BASE_URL: "api" }),
    /must be a valid http:\/\/ or https:\/\/ URL/,
  );
});

void test("loadWebDevProxyConfig uses the documented default target", () => {
  assert.deepEqual(loadWebDevProxyConfig({}), {
    apiProxyTarget: "http://127.0.0.1:3001",
  });
});

void test("loadWebDevProxyConfig rejects invalid proxy targets", () => {
  assert.throws(
    () => loadWebDevProxyConfig({ VITE_API_TARGET: "ws://127.0.0.1:3001" }),
    /VITE_API_TARGET must be a valid http:\/\/ or https:\/\/ URL/,
  );
});