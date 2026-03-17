import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../src/app.js";
import { loadApiRuntimeConfig, type ApiRuntimeEnv } from "../src/config.js";

function createTestApp(env: ApiRuntimeEnv = {}) {
  return buildApp(
    loadApiRuntimeConfig({
      LOG_LEVEL: "error",
      NODE_ENV: "test",
      ...env,
    }),
  );
}

void test("buildApp disables Fastify default request logging", async () => {
  const app = createTestApp();
  const appWithConfig = app as typeof app & {
    initialConfig?: {
      disableRequestLogging?: boolean;
    };
  };

  try {
    assert.equal(appWithConfig.initialConfig?.disableRequestLogging, true);
  } finally {
    await app.close();
  }
});

void test("GET /health returns the expected health payload and hardening headers", async () => {
  const app = createTestApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      service: "api",
      status: "ok",
    });
    assert.match(String(response.headers["x-request-id"]), /^req-\d+$/u);
    assert.equal(response.headers["cache-control"], "no-store, no-cache, must-revalidate");
    assert.equal(response.headers.pragma, "no-cache");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["x-frame-options"], "SAMEORIGIN");
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.equal(response.headers["cross-origin-opener-policy"], "same-origin");
    assert.equal(response.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.equal(response.headers["content-security-policy"], undefined);
    assert.equal(response.headers["strict-transport-security"], undefined);
  } finally {
    await app.close();
  }
});

void test("GET /health allows the unimatrix apex origin", async () => {
  const app = createTestApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        origin: "https://unimatrix-01.dev",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["access-control-allow-origin"], "https://unimatrix-01.dev");
    assert.equal(response.headers["access-control-expose-headers"], "x-request-id");
    assert.equal(response.headers["access-control-allow-credentials"], undefined);
  } finally {
    await app.close();
  }
});

void test("GET /health allows configured unimatrix subdomains", async () => {
  const app = createTestApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        origin: "https://status.unimatrix-01.dev",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["access-control-allow-origin"], "https://status.unimatrix-01.dev");
  } finally {
    await app.close();
  }
});

void test("GET /health allows the omnimatrix apex origin", async () => {
  const app = createTestApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        origin: "https://omnimatrix.dev",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["access-control-allow-origin"], "https://omnimatrix.dev");
  } finally {
    await app.close();
  }
});

void test("GET /health does not allow disallowed cross-origin requests", async () => {
  const app = createTestApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        origin: "https://evil.example",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  } finally {
    await app.close();
  }
});

void test("GET /health exposes x-request-id to allowed cross-origin callers", async () => {
  const app = createTestApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        origin: "https://status.omnimatrix.dev",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["x-request-id"]), /^req-\d+$/u);
    assert.equal(response.headers["access-control-allow-origin"], "https://status.omnimatrix.dev");
    assert.equal(response.headers["access-control-expose-headers"], "x-request-id");
  } finally {
    await app.close();
  }
});

void test("GET /health rejects unexpected query parameters with a validation envelope", async () => {
  const app = createTestApp();
  try {
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
    assert.equal(response.headers["x-request-id"], body.requestId);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  } finally {
    await app.close();
  }
});

void test("GET /missing-route returns the not-found envelope", async () => {
  const app = createTestApp();
  try {
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
    assert.equal(response.headers["x-request-id"], body.requestId);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  } finally {
    await app.close();
  }
});
