import assert from "node:assert/strict";
import test from "node:test";

import { loadApiRuntimeConfig } from "../src/config.js";

void test("loadApiRuntimeConfig uses documented defaults", () => {
  assert.deepEqual(loadApiRuntimeConfig({}), {
    host: "127.0.0.1",
    port: 3001,
    nodeEnv: "development",
  });
});

void test("loadApiRuntimeConfig trims and validates explicit values", () => {
  assert.deepEqual(
    loadApiRuntimeConfig({
      HOST: " 0.0.0.0 ",
      NODE_ENV: "production",
      PORT: "4000",
    }),
    {
      host: "0.0.0.0",
      port: 4000,
      nodeEnv: "production",
    },
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

void test("loadApiRuntimeConfig rejects blank HOST values", () => {
  assert.throws(
    () => loadApiRuntimeConfig({ HOST: "   " }),
    /HOST must not be empty when it is set/,
  );
});