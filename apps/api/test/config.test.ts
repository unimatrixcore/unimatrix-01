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
        { kind: "exact", origin: "http://localhost:5175" },
        { kind: "exact", origin: "http://127.0.0.1:5175" },
        { kind: "exact", origin: "http://localhost:4175" },
        { kind: "exact", origin: "http://127.0.0.1:4175" },
      ],
    },
    clerk: null,
    maxUploadBytes: 5_242_880,
    runDatabaseMigrations: false,
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
      CLERK_SECRET_KEY: " sk_test_123 ",
      CLERK_PUBLISHABLE_KEY: " pk_test_123 ",
      CLERK_JWT_KEY: " jwt_key_123 ",
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
          { kind: "exact", origin: "http://localhost:5175" },
          { kind: "exact", origin: "http://127.0.0.1:5175" },
          { kind: "exact", origin: "http://localhost:4175" },
          { kind: "exact", origin: "http://127.0.0.1:4175" },
        ],
      },
      clerk: {
        secretKey: "sk_test_123",
        publishableKey: "pk_test_123",
        jwtKey: "jwt_key_123",
      },
      maxUploadBytes: 5_242_880,
      runDatabaseMigrations: false,
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
  assert.equal(
    loadApiRuntimeConfig({
      NODE_ENV: "production",
      CLERK_SECRET_KEY: "sk_test_123",
      CLERK_PUBLISHABLE_KEY: "pk_test_123",
      CLERK_JWT_KEY: "jwt_key_123",
    }).logLevel,
    "info",
  );
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

void test("loadApiRuntimeConfig defaults clerk to null when all CLERK_* vars are absent outside production", () => {
  assert.equal(loadApiRuntimeConfig({ NODE_ENV: "development" }).clerk, null);
  assert.equal(loadApiRuntimeConfig({ NODE_ENV: "test" }).clerk, null);
});

void test("loadApiRuntimeConfig populates clerk when all CLERK_* vars are present", () => {
  assert.deepEqual(
    loadApiRuntimeConfig({
      NODE_ENV: "development",
      CLERK_SECRET_KEY: "sk_test_123",
      CLERK_PUBLISHABLE_KEY: "pk_test_123",
      CLERK_JWT_KEY: "jwt_key_123",
    }).clerk,
    {
      secretKey: "sk_test_123",
      publishableKey: "pk_test_123",
      jwtKey: "jwt_key_123",
    },
  );
});

void test("loadApiRuntimeConfig throws in production when any CLERK_* var is missing", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ NODE_ENV: "production" }),
    /CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, CLERK_JWT_KEY must be set in production/,
  );

  assert.throws(
    () =>
      loadApiRuntimeConfig({
        NODE_ENV: "production",
        CLERK_SECRET_KEY: "sk_test_123",
        CLERK_PUBLISHABLE_KEY: "pk_test_123",
      }),
    /CLERK_JWT_KEY must be set in production/,
  );
});

void test("loadApiRuntimeConfig throws outside production when only some CLERK_* vars are set", () => {
  assert.throws(
    () =>
      loadApiRuntimeConfig({
        NODE_ENV: "development",
        CLERK_SECRET_KEY: "sk_test_123",
      }),
    /CLERK_PUBLISHABLE_KEY, CLERK_JWT_KEY must be set together with the other CLERK_\* variables/,
  );

  assert.throws(
    () =>
      loadApiRuntimeConfig({
        NODE_ENV: "test",
        CLERK_SECRET_KEY: "sk_test_123",
        CLERK_PUBLISHABLE_KEY: "pk_test_123",
      }),
    /CLERK_JWT_KEY must be set together with the other CLERK_\* variables/,
  );
});

void test("loadApiRuntimeConfig rejects blank CLERK_* values", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ CLERK_SECRET_KEY: "   " }),
    /CLERK_SECRET_KEY must not be empty when it is set/,
  );
});

void test("loadApiRuntimeConfig defaults maxUploadBytes to 5 MiB", () => {
  assert.equal(loadApiRuntimeConfig({}).maxUploadBytes, 5_242_880);
});

void test("loadApiRuntimeConfig defaults runDatabaseMigrations to false", () => {
  assert.equal(loadApiRuntimeConfig({}).runDatabaseMigrations, false);
});

void test("loadApiRuntimeConfig parses DB_MIGRATE_ON_START truthy/falsy values", () => {
  assert.equal(loadApiRuntimeConfig({ DB_MIGRATE_ON_START: "true" }).runDatabaseMigrations, true);
  assert.equal(loadApiRuntimeConfig({ DB_MIGRATE_ON_START: " 1 " }).runDatabaseMigrations, true);
  assert.equal(loadApiRuntimeConfig({ DB_MIGRATE_ON_START: "false" }).runDatabaseMigrations, false);
  assert.equal(loadApiRuntimeConfig({ DB_MIGRATE_ON_START: "0" }).runDatabaseMigrations, false);
});

void test("loadApiRuntimeConfig rejects an invalid DB_MIGRATE_ON_START", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ DB_MIGRATE_ON_START: "yes" }),
    /DB_MIGRATE_ON_START must be one of true, 1, false, 0/,
  );
});

void test("loadApiRuntimeConfig parses an explicit MAX_UPLOAD_BYTES", () => {
  assert.equal(loadApiRuntimeConfig({ MAX_UPLOAD_BYTES: " 1048576 " }).maxUploadBytes, 1_048_576);
});

void test("loadApiRuntimeConfig rejects a zero MAX_UPLOAD_BYTES", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ MAX_UPLOAD_BYTES: "0" }),
    /MAX_UPLOAD_BYTES must be a positive integer/,
  );
});

void test("loadApiRuntimeConfig rejects a non-integer MAX_UPLOAD_BYTES", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ MAX_UPLOAD_BYTES: "1.5" }),
    /MAX_UPLOAD_BYTES must be a positive integer/,
  );
});

void test("loadApiRuntimeConfig rejects a negative MAX_UPLOAD_BYTES", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ MAX_UPLOAD_BYTES: "-5" }),
    /MAX_UPLOAD_BYTES must be a positive integer/,
  );
});

void test("loadApiRuntimeConfig rejects a blank MAX_UPLOAD_BYTES", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ MAX_UPLOAD_BYTES: "   " }),
    /MAX_UPLOAD_BYTES must not be empty when it is set/,
  );
});
