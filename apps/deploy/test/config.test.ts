import assert from "node:assert/strict";
import test from "node:test";

import { loadDeployRuntimeConfig } from "../src/config.js";

const BASE_ENV = {
  DOKPLOY_BASE_URL: "http://dokploy:3000",
  DOKPLOY_API_KEY: "dokploy_test_key",
};

void test("loadDeployRuntimeConfig uses documented defaults", () => {
  const config = loadDeployRuntimeConfig(BASE_ENV);

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3003);
  assert.equal(config.nodeEnv, "development");
  assert.equal(config.logLevel, "debug");
  assert.equal(config.dokployBaseUrl, "http://dokploy:3000");
});

void test("loadDeployRuntimeConfig trims and validates explicit values", () => {
  const config = loadDeployRuntimeConfig({
    ...BASE_ENV,
    HOST: " 0.0.0.0 ",
    LOG_LEVEL: " warn ",
    NODE_ENV: "production",
    PORT: "4000",
  });

  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.logLevel, "warn");
  assert.equal(config.port, 4000);
  assert.equal(config.nodeEnv, "production");
});

void test("loadDeployRuntimeConfig defaults LOG_LEVEL to info outside development", () => {
  assert.equal(loadDeployRuntimeConfig({ ...BASE_ENV, NODE_ENV: "test" }).logLevel, "info");
});

void test("loadDeployRuntimeConfig throws with no DOKPLOY_API_KEY", () => {
  assert.throws(
    () => loadDeployRuntimeConfig({ DOKPLOY_BASE_URL: "http://dokploy:3000" }),
    /DOKPLOY_API_KEY must be set/,
  );
});

void test("loadDeployRuntimeConfig throws with a blank DOKPLOY_API_KEY", () => {
  assert.throws(
    () =>
      loadDeployRuntimeConfig({
        DOKPLOY_BASE_URL: "http://dokploy:3000",
        DOKPLOY_API_KEY: "   ",
      }),
    /DOKPLOY_API_KEY must be set/,
  );
});

void test("loadDeployRuntimeConfig throws with no DOKPLOY_BASE_URL", () => {
  assert.throws(
    () => loadDeployRuntimeConfig({ DOKPLOY_API_KEY: "dokploy_test_key" }),
    /DOKPLOY_BASE_URL must be set/,
  );
});

void test("loadDeployRuntimeConfig rejects a DOKPLOY_BASE_URL that is not a URL", () => {
  assert.throws(
    () =>
      loadDeployRuntimeConfig({
        DOKPLOY_API_KEY: "dokploy_test_key",
        DOKPLOY_BASE_URL: "not a url",
      }),
    /DOKPLOY_BASE_URL must be a valid URL/,
  );
});

void test("loadDeployRuntimeConfig rejects a DOKPLOY_BASE_URL with an unsupported scheme", () => {
  assert.throws(
    () =>
      loadDeployRuntimeConfig({
        DOKPLOY_API_KEY: "dokploy_test_key",
        DOKPLOY_BASE_URL: "ftp://dokploy:3000",
      }),
    /DOKPLOY_BASE_URL must use http or https/,
  );
});

void test("loadDeployRuntimeConfig rejects invalid PORT values", () => {
  assert.throws(
    () => loadDeployRuntimeConfig({ ...BASE_ENV, PORT: "0" }),
    /PORT must be an integer between 1 and 65535/,
  );
});

void test("loadDeployRuntimeConfig rejects blank PORT values", () => {
  assert.throws(
    () => loadDeployRuntimeConfig({ ...BASE_ENV, PORT: "   " }),
    /PORT must not be empty when it is set/,
  );
});

void test("loadDeployRuntimeConfig rejects unsupported NODE_ENV values", () => {
  assert.throws(
    () => loadDeployRuntimeConfig({ ...BASE_ENV, NODE_ENV: "staging" }),
    /NODE_ENV must be one of development, test, production/,
  );
});

void test("loadDeployRuntimeConfig rejects unsupported LOG_LEVEL values", () => {
  assert.throws(
    () => loadDeployRuntimeConfig({ ...BASE_ENV, LOG_LEVEL: "trace" }),
    /LOG_LEVEL must be one of debug, info, warn, error/,
  );
});

void test("loadDeployRuntimeConfig rejects blank LOG_LEVEL values", () => {
  assert.throws(
    () => loadDeployRuntimeConfig({ ...BASE_ENV, LOG_LEVEL: "   " }),
    /LOG_LEVEL must not be empty when it is set/,
  );
});

void test("loadDeployRuntimeConfig never throws on a missing secrets-store variable — the binding constraint on secrets-status", () => {
  // Store configuration (SECRETS_BASE_URL, SECRETS_TLS_CERT_BASE64, SECRETS_PLATFORM_READ_TOKEN) is
  // read lazily, only on the secrets-status CLI path (src/secret-env/store.ts) — never here. This is
  // the regression test for that: an unset store variable reaches the container as an empty string,
  // not as absent, and a stack deployed before those values exist must not restart-loop.
  assert.doesNotThrow(() => loadDeployRuntimeConfig(BASE_ENV));
});

void test("loadDeployRuntimeConfig rejects blank HOST values", () => {
  assert.throws(
    () => loadDeployRuntimeConfig({ ...BASE_ENV, HOST: "   " }),
    /HOST must not be empty when it is set/,
  );
});

void test("health history path defaults locally and rejects a blank override", () => {
  assert.equal(loadDeployRuntimeConfig(BASE_ENV).databasePath, "local/deploy.sqlite");
  assert.equal(
    loadDeployRuntimeConfig({ ...BASE_ENV, DEPLOY_DATABASE_PATH: "/data/deploy.sqlite" })
      .databasePath,
    "/data/deploy.sqlite",
  );
  assert.throws(
    () => loadDeployRuntimeConfig({ ...BASE_ENV, DEPLOY_DATABASE_PATH: " " }),
    /DEPLOY_DATABASE_PATH must not be empty/,
  );
});
