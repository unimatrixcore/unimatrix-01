import assert from "node:assert/strict";
import test from "node:test";

import { loadCanvasConfig } from "../src/config.js";

export const syntheticEnv = {
  CANVAS_OWNER_USER_ID: "user_synthetic_owner",
  CANVAS_RESOURCE_URL: "https://canvas.example/mcp",
  CANVAS_ALLOWED_HOSTS: "canvas.example,127.0.0.1",
  CANVAS_ALLOWED_ORIGINS: "client.example",
  CLERK_SECRET_KEY: "sk_test_synthetic",
  CLERK_PUBLISHABLE_KEY: "pk_test_synthetic",
  CLERK_JWT_KEY: "synthetic-public-key",
  CLERK_ISSUER: "https://identity.example",
};

void test("requires explicit owner, resource, allowlists and Clerk configuration", () => {
  for (const name of Object.keys(syntheticEnv)) {
    for (const value of [undefined, "", " "]) {
      assert.throws(() => loadCanvasConfig({ ...syntheticEnv, [name]: value }), new RegExp(name));
    }
  }
});

void test("rejects malformed owner and resource configuration without echoing input", () => {
  const cases = [
    ["CANVAS_OWNER_USER_ID", "org_wrong"],
    ["CANVAS_OWNER_USER_ID", "user_has whitespace"],
    ["CANVAS_RESOURCE_URL", "http://canvas.example/mcp"],
    ["CANVAS_RESOURCE_URL", "https://canvas.example/other"],
    ["CANVAS_RESOURCE_URL", "https://canvas.example/mcp?secret=private"],
    ["CANVAS_RESOURCE_URL", "https://private:password@canvas.example/mcp"],
    ["CANVAS_RESOURCE_URL", "https://canvas.example/mcp#private"],
    ["CLERK_ISSUER", "http://identity.example"],
    ["CLERK_ISSUER", "not-a-url"],
    ["CANVAS_ALLOWED_HOSTS", "other.example"],
    ["CANVAS_ALLOWED_HOSTS", "https://canvas.example"],
    ["CANVAS_ALLOWED_ORIGINS", "client.example:443"],
    ["CANVAS_ALLOWED_ORIGINS", "client.example,"],
  ] as const;
  for (const [name, value] of cases) {
    assert.throws(() => loadCanvasConfig({ ...syntheticEnv, [name]: value }), {
      message: `Invalid ${name}.`,
    });
  }
});

void test("validates listening options and preserves the canonical external resource", () => {
  const config = loadCanvasConfig(syntheticEnv);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3020);
  assert.equal(config.resource, "https://canvas.example/mcp");
  assert.equal(config.ownerUserId, syntheticEnv.CANVAS_OWNER_USER_ID);
  for (const PORT of ["0", "65536", "3.5", "", " ", "3020garbage"]) {
    assert.throws(() => loadCanvasConfig({ ...syntheticEnv, PORT }), /PORT/);
  }
  assert.throws(() => loadCanvasConfig({ ...syntheticEnv, HOST: "" }), /HOST/);
  const explicit = loadCanvasConfig({ ...syntheticEnv, HOST: "0.0.0.0", PORT: "4000" });
  assert.equal(explicit.host, "0.0.0.0");
  assert.equal(explicit.port, 4000);
});
