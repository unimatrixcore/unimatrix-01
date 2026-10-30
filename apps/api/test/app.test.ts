import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { buildApp, buildAppOptions } from "../src/app.js";
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

void test("buildApp disables Fastify default request logging", () => {
  const options = buildAppOptions(
    loadApiRuntimeConfig({
      LOG_LEVEL: "error",
      NODE_ENV: "test",
    }),
  );

  assert.equal(options.logController.disableRequestLogging, true);
});

void test("proxy headers are trusted only from the configured proxy IP", async () => {
  const app = Fastify(
    buildAppOptions(
      loadApiRuntimeConfig({
        NODE_ENV: "test",
        LOG_LEVEL: "error",
        TRUST_PROXY: "10.0.1.166",
      }),
    ),
  );
  app.get("/identity", (request, reply) =>
    reply.send({
      ip: request.ip,
      host: request.host,
      protocol: request.protocol,
    }),
  );

  try {
    for (const peer of [
      "10.0.1.166",
      "::ffff:10.0.1.166",
      "10.0.1.167",
      "::ffff:10.0.1.167",
      "203.0.113.10",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: "/identity",
        remoteAddress: peer,
        headers: {
          host: "api.example.test",
          "x-forwarded-for": "192.0.2.250, 198.51.100.42",
          "x-forwarded-host": "public.example.test",
          "x-forwarded-proto": "https",
        },
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(
        response.json(),
        peer === "10.0.1.166" || peer === "::ffff:10.0.1.166"
          ? {
              ip: "198.51.100.42",
              host: "public.example.test",
              protocol: "https",
            }
          : {
              ip: peer,
              host: "api.example.test",
              protocol: "http",
            },
      );
    }
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
    assert.equal(
      response.headers["access-control-allow-origin"],
      "https://status.unimatrix-01.dev",
    );
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

void test("OPTIONS /health returns the configured CORS preflight response", async () => {
  const app = createTestApp();
  try {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: {
        origin: "https://status.unimatrix-01.dev",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-client-version,content-type",
      },
    });

    assert.equal(response.statusCode, 204);
    assert.equal(response.body, "");
    assert.equal(
      response.headers["access-control-allow-origin"],
      "https://status.unimatrix-01.dev",
    );
    // Read and write methods must both be advertised: the user-data routes
    // use PUT/POST/DELETE, so a cross-origin browser preflight has to see the
    // full advertised method set or every write is blocked.
    const allowMethods = String(response.headers["access-control-allow-methods"]);
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
      assert.match(allowMethods, new RegExp(`\\b${method}\\b`, "u"));
    }
    assert.equal(response.headers["access-control-allow-credentials"], undefined);
  } finally {
    await app.close();
  }
});

void test("GET /health does not throw when the origin header carries port zero", async () => {
  const app = createTestApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        origin: "https://status.unimatrix-01.dev:0",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
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

void test("a burst past the ceiling is answered with the API's own 429 envelope", async () => {
  const app = createTestApp();

  try {
    // One over the limit. The store is per-instance and keyed by IP, and
    // `inject` presents every request as the same one, so this is the whole
    // window for this app.
    let last = await app.inject({ method: "GET", url: "/health" });

    for (let sent = 1; sent <= 300; sent += 1) {
      last = await app.inject({ method: "GET", url: "/health" });
    }

    assert.equal(last.statusCode, 429);

    const body: { error: { code: string; statusCode: number }; requestId: string } = last.json();

    // The shape every other error on this API uses — not the plugin's own.
    assert.equal(body.error.code, "RATE_LIMITED");
    assert.equal(body.error.statusCode, 429);
    assert.equal(typeof body.requestId, "string");
  } finally {
    await app.close();
  }
});
