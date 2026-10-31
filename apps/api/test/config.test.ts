import { rootCertificates } from "node:tls";
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
        { kind: "exact", origin: "http://localhost:5177" },
        { kind: "exact", origin: "http://127.0.0.1:5177" },
        { kind: "exact", origin: "http://localhost:4177" },
        { kind: "exact", origin: "http://127.0.0.1:4177" },
      ],
    },
    clerk: null,
    secretsStore: null,
    deployService: null,
    maxUploadBytes: 5_242_880,
    maxUserStorageBytes: 52_428_800,
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
          { kind: "exact", origin: "http://localhost:5177" },
          { kind: "exact", origin: "http://127.0.0.1:5177" },
          { kind: "exact", origin: "http://localhost:4177" },
          { kind: "exact", origin: "http://127.0.0.1:4177" },
        ],
      },
      clerk: {
        secretKey: "sk_test_123",
        publishableKey: "pk_test_123",
        jwtKey: "jwt_key_123",
      },
      secretsStore: null,
      deployService: null,
      maxUploadBytes: 5_242_880,
      maxUserStorageBytes: 52_428_800,
      runDatabaseMigrations: false,
    },
  );
});

void test("loadApiRuntimeConfig accepts explicit proxy IP addresses", () => {
  for (const address of ["10.0.1.166", "2001:db8::1", "::ffff:10.0.1.166"]) {
    assert.equal(loadApiRuntimeConfig({ TRUST_PROXY: ` ${address} ` }).trustProxy, address);
  }
});

void test("loadApiRuntimeConfig rejects hop-count proxy trust with a migration error", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ TRUST_PROXY: " 1 " }),
    /TRUST_PROXY=1 is unsupported.*explicit IP address instead of a hop count/u,
  );
});

void test("loadApiRuntimeConfig preserves disabled proxy trust", () => {
  for (const value of ["false", "0"]) {
    assert.equal(loadApiRuntimeConfig({ TRUST_PROXY: value }).trustProxy, false);
  }
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
  for (const value of [
    "yes",
    "2",
    "10.0.1.999",
    "10.0.1.166/24",
    "10.0.1.166,10.0.1.167",
    "localhost",
  ]) {
    assert.throws(
      () => loadApiRuntimeConfig({ TRUST_PROXY: value }),
      /TRUST_PROXY must be an explicit IP address or one of true, false, 0/u,
    );
  }
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

void test("loadApiRuntimeConfig defaults maxUserStorageBytes to 50 MiB", () => {
  assert.equal(loadApiRuntimeConfig({}).maxUserStorageBytes, 52_428_800);
});

void test("loadApiRuntimeConfig parses an explicit MAX_USER_STORAGE_BYTES", () => {
  assert.equal(
    loadApiRuntimeConfig({ MAX_USER_STORAGE_BYTES: " 1048576 " }).maxUserStorageBytes,
    1_048_576,
  );
});

void test("loadApiRuntimeConfig rejects a zero MAX_USER_STORAGE_BYTES", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ MAX_USER_STORAGE_BYTES: "0" }),
    /MAX_USER_STORAGE_BYTES must be a positive integer/,
  );
});

void test("loadApiRuntimeConfig rejects a non-integer MAX_USER_STORAGE_BYTES", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ MAX_USER_STORAGE_BYTES: "1.5" }),
    /MAX_USER_STORAGE_BYTES must be a positive integer/,
  );
});

void test("loadApiRuntimeConfig rejects a negative MAX_USER_STORAGE_BYTES", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ MAX_USER_STORAGE_BYTES: "-5" }),
    /MAX_USER_STORAGE_BYTES must be a positive integer/,
  );
});

void test("loadApiRuntimeConfig rejects a blank MAX_USER_STORAGE_BYTES", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ MAX_USER_STORAGE_BYTES: "   " }),
    /MAX_USER_STORAGE_BYTES must not be empty when it is set/,
  );
});

void test("loadApiRuntimeConfig defaults secretsStore to null when both vars are absent, including in production", () => {
  assert.equal(loadApiRuntimeConfig({ NODE_ENV: "development" }).secretsStore, null);
  assert.equal(
    loadApiRuntimeConfig({
      NODE_ENV: "production",
      CLERK_SECRET_KEY: "sk_test_123",
      CLERK_PUBLISHABLE_KEY: "pk_test_123",
      CLERK_JWT_KEY: "jwt_key_123",
    }).secretsStore,
    null,
  );
});

void test("loadApiRuntimeConfig populates secretsStore when both vars are present", () => {
  assert.deepEqual(
    loadApiRuntimeConfig({
      SECRETS_BASE_URL: " http://secrets.internal:3002 ",
      SECRETS_SERVICE_TOKEN: " svc_test_token ",
    }).secretsStore,
    {
      baseUrl: "http://secrets.internal:3002",
      serviceToken: "svc_test_token",
      integrationsManageToken: null,
      platformWriteToken: null,
      caCertificatePem: null,
    },
  );
});

void test("loadApiRuntimeConfig throws when only SECRETS_BASE_URL is set", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ SECRETS_BASE_URL: "http://secrets.internal:3002" }),
    /SECRETS_BASE_URL and SECRETS_SERVICE_TOKEN must be set together/,
  );
});

void test("loadApiRuntimeConfig throws when only SECRETS_SERVICE_TOKEN is set", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ SECRETS_SERVICE_TOKEN: "svc_test_token" }),
    /SECRETS_BASE_URL and SECRETS_SERVICE_TOKEN must be set together/,
  );
});

void test("loadApiRuntimeConfig rejects a blank SECRETS_BASE_URL", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ SECRETS_BASE_URL: "   " }),
    /SECRETS_BASE_URL must not be empty when it is set/,
  );
});

void test("loadApiRuntimeConfig rejects a blank SECRETS_SERVICE_TOKEN", () => {
  assert.throws(
    () =>
      loadApiRuntimeConfig({
        SECRETS_BASE_URL: "http://secrets.internal:3002",
        SECRETS_SERVICE_TOKEN: "   ",
      }),
    /SECRETS_SERVICE_TOKEN must not be empty when it is set/,
  );
});

void test("loadApiRuntimeConfig rejects an unparsable SECRETS_BASE_URL", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ SECRETS_BASE_URL: "not-a-url" }),
    /SECRETS_BASE_URL must be a valid http:\/\/ or https:\/\/ URL/,
  );
});

void test("loadApiRuntimeConfig rejects a non-http(s) SECRETS_BASE_URL", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ SECRETS_BASE_URL: "ftp://secrets.internal" }),
    /SECRETS_BASE_URL must use http:\/\/ or https:\/\//,
  );
});

void test("loadApiRuntimeConfig populates both admin tokens alongside a configured store", () => {
  assert.deepEqual(
    loadApiRuntimeConfig({
      SECRETS_BASE_URL: "http://secrets.internal:3002",
      SECRETS_SERVICE_TOKEN: "svc_read_token",
      SECRETS_INTEGRATIONS_MANAGE_TOKEN: " svc_integrations_manage_token ",
      SECRETS_PLATFORM_WRITE_TOKEN: " svc_platform_write_token ",
    }).secretsStore,
    {
      baseUrl: "http://secrets.internal:3002",
      serviceToken: "svc_read_token",
      integrationsManageToken: "svc_integrations_manage_token",
      platformWriteToken: "svc_platform_write_token",
      caCertificatePem: null,
    },
  );
});

const TEST_CERT_PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const TEST_CERT_BASE64 = Buffer.from(TEST_CERT_PEM).toString("base64");

void test("loadApiRuntimeConfig decodes the store certificate for an https base URL", () => {
  assert.deepEqual(
    loadApiRuntimeConfig({
      SECRETS_BASE_URL: "https://secrets:3001",
      SECRETS_SERVICE_TOKEN: "svc_read_token",
      SECRETS_TLS_CERT_BASE64: TEST_CERT_BASE64,
    }).secretsStore,
    {
      baseUrl: "https://secrets:3001",
      serviceToken: "svc_read_token",
      integrationsManageToken: null,
      platformWriteToken: null,
      caCertificatePem: TEST_CERT_PEM,
    },
  );
});

void test("loadApiRuntimeConfig reads the scheme from the parsed URL, not the raw text", () => {
  // `HTTPS://` is a valid URL whose protocol normalises to `https:`, so it must
  // demand the certificate exactly as the lowercase form does.
  assert.throws(
    () =>
      loadApiRuntimeConfig({
        SECRETS_BASE_URL: "HTTPS://secrets:3001",
        SECRETS_SERVICE_TOKEN: "svc_read_token",
      }),
    /SECRETS_TLS_CERT_BASE64 must be set when SECRETS_BASE_URL is https/,
  );

  assert.throws(
    () =>
      loadApiRuntimeConfig({
        SECRETS_BASE_URL: "HTTP://secrets:3001",
        SECRETS_SERVICE_TOKEN: "svc_read_token",
        SECRETS_TLS_CERT_BASE64: TEST_CERT_BASE64,
      }),
    /SECRETS_TLS_CERT_BASE64 must not be set when SECRETS_BASE_URL is http/,
  );
});

void test("loadApiRuntimeConfig throws when an https base URL has no certificate", () => {
  assert.throws(
    () =>
      loadApiRuntimeConfig({
        SECRETS_BASE_URL: "https://secrets:3001",
        SECRETS_SERVICE_TOKEN: "svc_read_token",
      }),
    /SECRETS_TLS_CERT_BASE64 must be set when SECRETS_BASE_URL is https/,
  );
});

void test("loadApiRuntimeConfig throws when an http base URL carries a certificate", () => {
  assert.throws(
    () =>
      loadApiRuntimeConfig({
        SECRETS_BASE_URL: "http://secrets:3001",
        SECRETS_SERVICE_TOKEN: "svc_read_token",
        SECRETS_TLS_CERT_BASE64: TEST_CERT_BASE64,
      }),
    /SECRETS_TLS_CERT_BASE64 must not be set when SECRETS_BASE_URL is http/,
  );
});

void test("loadApiRuntimeConfig rejects a certificate that does not decode to PEM", () => {
  assert.throws(
    () =>
      loadApiRuntimeConfig({
        SECRETS_BASE_URL: "https://secrets:3001",
        SECRETS_SERVICE_TOKEN: "svc_read_token",
        SECRETS_TLS_CERT_BASE64: Buffer.from("not a certificate").toString("base64"),
      }),
    /SECRETS_TLS_CERT_BASE64 must be a base64-encoded PEM certificate/,
  );
});

void test("loadApiRuntimeConfig throws when the certificate is set without a configured store", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ SECRETS_TLS_CERT_BASE64: TEST_CERT_BASE64 }),
    /SECRETS_TLS_CERT_BASE64 must not be set unless SECRETS_BASE_URL/,
  );
});

for (const variableName of [
  "SECRETS_INTEGRATIONS_MANAGE_TOKEN",
  "SECRETS_PLATFORM_WRITE_TOKEN",
] as const) {
  void test(`loadApiRuntimeConfig throws when ${variableName} is set without a configured store`, () => {
    assert.throws(
      () => loadApiRuntimeConfig({ [variableName]: "svc_admin_token" }),
      new RegExp(`${variableName} must not be set unless SECRETS_BASE_URL`),
    );
  });

  void test(`loadApiRuntimeConfig rejects a blank ${variableName}`, () => {
    assert.throws(
      () =>
        loadApiRuntimeConfig({
          SECRETS_BASE_URL: "http://secrets.internal:3002",
          SECRETS_SERVICE_TOKEN: "svc_read_token",
          [variableName]: "   ",
        }),
      new RegExp(`${variableName} must not be empty when it is set`),
    );
  });
}

/**
 * All three tokens must differ. The store answers a wrong-capability or
 * out-of-scope caller with the same 404 it uses for a missing name, so any two
 * of these sharing a value boots cleanly and then reports every call the
 * shared token cannot make as "not found".
 */
void test("loadApiRuntimeConfig throws when the integrations manage token equals the read token", () => {
  assert.throws(
    () =>
      loadApiRuntimeConfig({
        SECRETS_BASE_URL: "http://secrets.internal:3002",
        SECRETS_SERVICE_TOKEN: "svc_shared_token",
        SECRETS_INTEGRATIONS_MANAGE_TOKEN: "svc_shared_token",
      }),
    /SECRETS_INTEGRATIONS_MANAGE_TOKEN must not equal SECRETS_SERVICE_TOKEN/,
  );
});

void test("loadApiRuntimeConfig throws when the platform write token equals the read token", () => {
  assert.throws(
    () =>
      loadApiRuntimeConfig({
        SECRETS_BASE_URL: "http://secrets.internal:3002",
        SECRETS_SERVICE_TOKEN: "svc_shared_token",
        SECRETS_PLATFORM_WRITE_TOKEN: "svc_shared_token",
      }),
    /SECRETS_PLATFORM_WRITE_TOKEN must not equal SECRETS_SERVICE_TOKEN/,
  );
});

void test("loadApiRuntimeConfig throws when the two admin tokens are the same value", () => {
  assert.throws(
    () =>
      loadApiRuntimeConfig({
        SECRETS_BASE_URL: "http://secrets.internal:3002",
        SECRETS_SERVICE_TOKEN: "svc_read_token",
        SECRETS_INTEGRATIONS_MANAGE_TOKEN: "svc_shared_admin_token",
        SECRETS_PLATFORM_WRITE_TOKEN: "svc_shared_admin_token",
      }),
    /SECRETS_PLATFORM_WRITE_TOKEN must not equal SECRETS_INTEGRATIONS_MANAGE_TOKEN/,
  );
});

void test("deploy service config is optional, including in production", () => {
  assert.equal(loadApiRuntimeConfig({}).deployService, null);
  assert.equal(
    loadApiRuntimeConfig({
      NODE_ENV: "production",
      CLERK_SECRET_KEY: "key",
      CLERK_PUBLISHABLE_KEY: "key",
      CLERK_JWT_KEY: "key",
    }).deployService,
    null,
  );
});

void test("deploy service config accepts local HTTP and pinned HTTPS origins", () => {
  assert.deepEqual(
    loadApiRuntimeConfig({
      DEPLOY_BASE_URL: " http://localhost:3003/ ",
      DEPLOY_SERVICE_TOKEN: " token ",
    }).deployService,
    {
      baseUrl: "http://localhost:3003",
      serviceToken: "token",
      caCertificatePem: null,
    },
  );
  assert.deepEqual(
    loadApiRuntimeConfig({
      DEPLOY_BASE_URL: "HTTPS://deploy:3001",
      DEPLOY_SERVICE_TOKEN: "token",
      DEPLOY_TLS_CERT_BASE64: Buffer.from(rootCertificates[0]!).toString("base64"),
    }).deployService,
    {
      baseUrl: "https://deploy:3001",
      serviceToken: "token",
      caCertificatePem: rootCertificates[0],
    },
  );
});

void test("deploy service config rejects incomplete and blank credentials without exposing values", () => {
  for (const env of [
    { DEPLOY_BASE_URL: "http://deploy:3001" },
    { DEPLOY_SERVICE_TOKEN: "private-token" },
    { DEPLOY_TLS_CERT_BASE64: Buffer.from(rootCertificates[0]!).toString("base64") },
    { DEPLOY_BASE_URL: "" },
    { DEPLOY_SERVICE_TOKEN: " " },
    { DEPLOY_TLS_CERT_BASE64: " " },
  ]) {
    assert.throws(
      () => loadApiRuntimeConfig(env),
      (error: Error) => {
        assert.match(error.message, /DEPLOY_/u);
        assert.doesNotMatch(error.message, /private-token/u);
        return true;
      },
    );
  }
});

void test("deploy service config rejects non-origin URLs and never prints URL credentials", () => {
  for (const url of [
    "invalid",
    "ftp://deploy",
    "https://name:private-token@deploy",
    "http://@deploy",
    "http://deploy/path",
    "http://deploy?x=1",
    "http://deploy#fragment",
    "http://deploy/path/..",
    "http://deploy?",
    "http://deploy#",
    "http://deploy\\path",
  ]) {
    assert.throws(
      () => loadApiRuntimeConfig({ DEPLOY_BASE_URL: url, DEPLOY_SERVICE_TOKEN: "token" }),
      (error: Error) => {
        assert.match(error.message, /DEPLOY_BASE_URL/u);
        assert.doesNotMatch(error.message, /private-token/u);
        return true;
      },
    );
  }
});

void test("deploy service config requires HTTPS in production and certificate pins only with HTTPS", () => {
  assert.throws(
    () =>
      loadApiRuntimeConfig({
        NODE_ENV: "production",
        CLERK_SECRET_KEY: "key",
        CLERK_PUBLISHABLE_KEY: "key",
        CLERK_JWT_KEY: "key",
        DEPLOY_BASE_URL: "http://deploy",
        DEPLOY_SERVICE_TOKEN: "token",
      }),
    /DEPLOY_BASE_URL must use https/u,
  );
  assert.throws(
    () =>
      loadApiRuntimeConfig({ DEPLOY_BASE_URL: "https://deploy", DEPLOY_SERVICE_TOKEN: "token" }),
    /DEPLOY_TLS_CERT_BASE64 must be set/u,
  );
  assert.throws(
    () =>
      loadApiRuntimeConfig({
        DEPLOY_BASE_URL: "http://deploy",
        DEPLOY_SERVICE_TOKEN: "token",
        DEPLOY_TLS_CERT_BASE64: Buffer.from(rootCertificates[0]!).toString("base64"),
      }),
    /DEPLOY_TLS_CERT_BASE64 must not be set/u,
  );
  assert.throws(
    () =>
      loadApiRuntimeConfig({
        DEPLOY_BASE_URL: "https://deploy",
        DEPLOY_SERVICE_TOKEN: "token",
        DEPLOY_TLS_CERT_BASE64: Buffer.from("invalid").toString("base64"),
      }),
    /DEPLOY_TLS_CERT_BASE64 must be a base64-encoded PEM/u,
  );
});

void test("deploy certificate parser rejects malformed X509 content before boot", () => {
  assert.throws(
    () =>
      loadApiRuntimeConfig({
        DEPLOY_BASE_URL: "https://deploy",
        DEPLOY_SERVICE_TOKEN: "private-token",
        DEPLOY_TLS_CERT_BASE64: Buffer.from(
          "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----",
        ).toString("base64"),
      }),
    /DEPLOY_TLS_CERT_BASE64 must be a base64-encoded PEM/u,
  );
});
