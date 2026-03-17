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
  assert.match(response.body, /"code":"VALIDATION_ERROR"/u);
  assert.match(response.body, /"message":"Request validation failed"/u);
  assert.match(response.body, /"statusCode":400/u);
  assert.match(response.body, /"issues":\[/u);
  assert.match(response.body, /"requestId":"req-1"/u);
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
  assert.deepEqual(response.json(), {
    error: {
      code: "NOT_FOUND",
      message: "Route not found",
      statusCode: 404,
    },
    requestId: "req-1",
  });
});
