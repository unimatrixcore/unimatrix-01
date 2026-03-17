import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../src/app.js";

function createTestApp() {
  return buildApp({
    host: "127.0.0.1",
    nodeEnv: "test",
    port: 3001,
  });
}

void test("GET /health returns the expected health payload", async (t) => {
  const app = createTestApp();
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/health",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    service: "api",
    status: "ok",
  });
});

void test("GET /health rejects unexpected query parameters with a validation envelope", async (t) => {
  const app = createTestApp();
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/health?unexpected=1",
  });

  assert.equal(response.statusCode, 400);
  const body: {
    error: {
      code: string;
      details: {
        issues: unknown[];
      };
      message: string;
      statusCode: number;
    };
    requestId: string;
  } = response.json();

  assert.equal(body.error.code, "VALIDATION_ERROR");
  assert.equal(body.error.message, "Request validation failed");
  assert.equal(body.error.statusCode, 400);
  assert.ok(body.error.details.issues.length > 0);
  assert.match(body.requestId, /^req-\d+$/u);
});

void test("GET /missing-route returns the not-found envelope", async (t) => {
  const app = createTestApp();
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/missing-route",
  });

  assert.equal(response.statusCode, 404);
  const body: {
    error: {
      code: string;
      message: string;
      statusCode: number;
    };
    requestId: string;
  } = response.json();

  assert.deepEqual(body.error, {
    code: "NOT_FOUND",
    message: "Route not found",
    statusCode: 404,
  });
  assert.match(body.requestId, /^req-\d+$/u);
});
