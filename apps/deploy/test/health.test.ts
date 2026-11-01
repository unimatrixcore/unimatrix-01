import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../src/app.js";
import { loadDeployRuntimeConfig, type DeployRuntimeEnv } from "../src/config.js";
import type { DokployClient } from "../src/dokploy/client.js";

const BASE_ENV: DeployRuntimeEnv = {
  LOG_LEVEL: "error",
  NODE_ENV: "test",
  DOKPLOY_BASE_URL: "http://dokploy:3000",
  DOKPLOY_API_KEY: "dokploy_test_key",
  DEPLOY_DATABASE_PATH: ":memory:",
};

const stubDokployClient: DokployClient = {
  getDokployVersion: () => Promise.reject(new Error("not used in these tests")),
  getContainers: () => Promise.reject(new Error("not used in these tests")),
  getProjects: () => Promise.reject(new Error("not used in these tests")),
  getCompose: () => Promise.reject(new Error("not used in these tests")),
  updateComposeSettings: () => Promise.reject(new Error("not used in these tests")),
};

function createTestApp(env: DeployRuntimeEnv = {}) {
  return buildApp(loadDeployRuntimeConfig({ ...BASE_ENV, ...env }), { dokploy: stubDokployClient });
}

void test("GET /health returns the expected health payload and cache headers", async () => {
  const app = createTestApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      service: "deploy",
      status: "ok",
    });
    assert.equal(response.headers["cache-control"], "no-store, no-cache, must-revalidate");
    assert.equal(response.headers.pragma, "no-cache");
    assert.equal(response.headers["x-deploy-capabilities"], "commit-subject-v1");
  } finally {
    await app.close();
  }
});

void test("GET /health rejects unexpected query parameters", async () => {
  const app = createTestApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/health?unexpected=1",
    });

    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
  }
});

void test("GET /missing-route requires authentication", async () => {
  const app = createTestApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/missing-route",
    });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), {
      error: {
        code: "UNAUTHORIZED",
        message: "Service authentication required",
      },
    });
  } finally {
    await app.close();
  }
});
