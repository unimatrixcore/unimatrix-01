import assert from "node:assert/strict";
import test from "node:test";

import { loadApiRuntimeConfig } from "../src/config.js";

void test("loadApiRuntimeConfig uses documented defaults", () => {
  assert.deepEqual(loadApiRuntimeConfig({}), {
    host: "127.0.0.1",
    port: 3001,
    nodeEnv: "development",
    logLevel: "debug",
    trustProxy: false,
    cors: {
      allowedOrigins: [
        { kind: "exact", origin: "https://unimatrix-01.dev" },
        {
          kind: "wildcard-subdomain",
          protocol: "https:",
          domainSuffix: "unimatrix-01.dev",
          port: null,
        },
        { kind: "exact", origin: "https://omnimatrix.dev" },
        {
          kind: "wildcard-subdomain",
          protocol: "https:",
          domainSuffix: "omnimatrix.dev",
          port: null,
        },
        { kind: "exact", origin: "http://localhost:5173" },
        { kind: "exact", origin: "http://127.0.0.1:5173" },
        { kind: "exact", origin: "http://localhost:4173" },
        { kind: "exact", origin: "http://127.0.0.1:4173" },
      ],
    },
  });
});

void test("loadApiRuntimeConfig trims and validates explicit values", () => {
  assert.deepEqual(
    loadApiRuntimeConfig({
      HOST: " 0.0.0.0 ",
      LOG_LEVEL: " warn ",
      NODE_ENV: "production",
      PORT: "4000",
      TRUST_PROXY: " true ",
    }),
    {
      host: "0.0.0.0",
      logLevel: "warn",
      port: 4000,
      nodeEnv: "production",
      trustProxy: true,
      cors: {
        allowedOrigins: [
          { kind: "exact", origin: "https://unimatrix-01.dev" },
          {
            kind: "wildcard-subdomain",
            protocol: "https:",
            domainSuffix: "unimatrix-01.dev",
            port: null,
          },
          { kind: "exact", origin: "https://omnimatrix.dev" },
          {
            kind: "wildcard-subdomain",
            protocol: "https:",
            domainSuffix: "omnimatrix.dev",
            port: null,
          },
          { kind: "exact", origin: "http://localhost:5173" },
          { kind: "exact", origin: "http://127.0.0.1:5173" },
          { kind: "exact", origin: "http://localhost:4173" },
          { kind: "exact", origin: "http://127.0.0.1:4173" },
        ],
      },
    },
  );
});

void test("loadApiRuntimeConfig preserves single-hop TRUST_PROXY=1 semantics", () => {
  assert.equal(loadApiRuntimeConfig({ TRUST_PROXY: " 1 " }).trustProxy, 1);
});

void test("loadApiRuntimeConfig replaces default cors origins when CORS_ALLOWED_ORIGINS is set", () => {
  assert.deepEqual(
    loadApiRuntimeConfig({
      CORS_ALLOWED_ORIGINS: "https://status.example.com, https://*.deploy.example.com",
    }).cors,
    {
      allowedOrigins: [
        { kind: "exact", origin: "https://status.example.com" },
        {
          kind: "wildcard-subdomain",
          protocol: "https:",
          domainSuffix: "deploy.example.com",
          port: null,
        },
      ],
    },
  );
});

void test("loadApiRuntimeConfig parses exact cors origins", () => {
  assert.deepEqual(
    loadApiRuntimeConfig({
      CORS_ALLOWED_ORIGINS: "https://api.example.test:8443",
    }).cors,
    {
      allowedOrigins: [{ kind: "exact", origin: "https://api.example.test:8443" }],
    },
  );
});

void test("loadApiRuntimeConfig parses unimatrix wildcard cors origins", () => {
  assert.deepEqual(
    loadApiRuntimeConfig({
      CORS_ALLOWED_ORIGINS: "https://*.unimatrix-01.dev",
    }).cors,
    {
      allowedOrigins: [
        {
          kind: "wildcard-subdomain",
          protocol: "https:",
          domainSuffix: "unimatrix-01.dev",
          port: null,
        },
      ],
    },
  );
});

void test("loadApiRuntimeConfig parses omnimatrix wildcard cors origins", () => {
  assert.deepEqual(
    loadApiRuntimeConfig({
      CORS_ALLOWED_ORIGINS: "https://*.omnimatrix.dev",
    }).cors,
    {
      allowedOrigins: [
        {
          kind: "wildcard-subdomain",
          protocol: "https:",
          domainSuffix: "omnimatrix.dev",
          port: null,
        },
      ],
    },
  );
});

void test("loadApiRuntimeConfig defaults LOG_LEVEL to info outside development", () => {
  assert.equal(loadApiRuntimeConfig({ NODE_ENV: "test" }).logLevel, "info");
  assert.equal(loadApiRuntimeConfig({ NODE_ENV: "production" }).logLevel, "info");
});

void test("loadApiRuntimeConfig rejects invalid PORT values", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ PORT: "0" }),
    /PORT must be an integer between 1 and 65535/,
  );
});

void test("loadApiRuntimeConfig rejects unsupported NODE_ENV values", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ NODE_ENV: "staging" }),
    /NODE_ENV must be one of development, test, production/,
  );
});

void test("loadApiRuntimeConfig rejects unsupported LOG_LEVEL values", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ LOG_LEVEL: "trace" }),
    /LOG_LEVEL must be one of debug, info, warn, error/,
  );
});

void test("loadApiRuntimeConfig rejects blank LOG_LEVEL values", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ LOG_LEVEL: "   " }),
    /LOG_LEVEL must not be empty when it is set/,
  );
});

void test("loadApiRuntimeConfig rejects unsupported TRUST_PROXY values", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ TRUST_PROXY: "yes" }),
    /TRUST_PROXY must be one of true, 1, false, 0/,
  );
});

void test("loadApiRuntimeConfig rejects blank HOST values", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ HOST: "   " }),
    /HOST must not be empty when it is set/,
  );
});

void test("loadApiRuntimeConfig rejects blank TRUST_PROXY values", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ TRUST_PROXY: "   " }),
    /TRUST_PROXY must not be empty when it is set/,
  );
});

void test("loadApiRuntimeConfig rejects malformed CORS_ALLOWED_ORIGINS values", () => {
  const malformedValues = [
    "https://unimatrix-01.dev, ,https://omnimatrix.dev",
    "ws://unimatrix-01.dev",
    "https://unimatrix-01.dev/path",
    "https://api.*.unimatrix-01.dev",
    "https://*.localhost",
    "https://*.dev",
    "https://*.127.0.0.1",
  ] as const;

  for (const malformedValue of malformedValues) {
    assert.throws(
      () => loadApiRuntimeConfig({ CORS_ALLOWED_ORIGINS: malformedValue }),
      /CORS_ALLOWED_ORIGINS/u,
    );
  }
});
