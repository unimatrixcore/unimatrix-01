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
  });
});

void test("loadApiRuntimeConfig trims and validates explicit values", () => {
  assert.deepEqual(
    loadApiRuntimeConfig({
      HOST: " 0.0.0.0 ",
      LOG_LEVEL: " warn ",
      NODE_ENV: "production",
      PORT: "4000",
      TRUST_PROXY: " 1 ",
    }),
    {
      host: "0.0.0.0",
      logLevel: "warn",
      port: 4000,
      nodeEnv: "production",
      trustProxy: true,
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
