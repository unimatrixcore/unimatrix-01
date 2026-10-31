import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import { buildApp } from "../src/app.js";
import { loadDeployRuntimeConfig } from "../src/config.js";
import type { DokployClient } from "../src/dokploy/client.js";
import { requireDeployCapability } from "../src/plugins/auth.js";
import { openServiceTokenStore } from "../src/service-tokens/store.js";

const config = loadDeployRuntimeConfig({
  NODE_ENV: "test",
  LOG_LEVEL: "info",
  DEPLOY_DATABASE_PATH: ":memory:",
  DOKPLOY_API_KEY: "unused-dokploy-key",
  DOKPLOY_BASE_URL: "http://dokploy:3000",
});
const dokploy: DokployClient = {
  getDokployVersion: () => Promise.reject(new Error("unused")),
  getContainers: () => Promise.reject(new Error("unused")),
  getProjects: () => Promise.reject(new Error("unused")),
  getCompose: () => Promise.reject(new Error("unused")),
  updateComposeSettings: () => Promise.reject(new Error("unused")),
};

function fixture() {
  const store = openServiceTokenStore(":memory:");
  const read = store.issue({ name: "api-read", capability: "read" }).token;
  const manage = store.issue({ name: "api-manage", capability: "manage" }).token;
  const logs: string[] = [];
  const app = buildApp(config, {
    dokploy,
    serviceTokens: store,
    loggerStream: {
      write: (chunk) => {
        logs.push(chunk);
      },
    },
  });
  app.register((routes) => {
    routes.get("/test/read", (request) => request.serviceCaller);
    routes.get("/test/manage", { preHandler: requireDeployCapability("manage") }, () => ({
      ok: true,
    }));
    routes.get("/test/explicit-read", { preHandler: requireDeployCapability("read") }, () => ({
      ok: true,
    }));
    routes.post(
      "/test/write",
      { schema: { body: z.object({ value: z.string() }).strict() } },
      () => ({ ok: true }),
    );
    return Promise.resolve();
  });
  return { app, store, read, manage, logs };
}

void test("anonymous allowlist is only the matched health GET/HEAD route", async () => {
  const { app } = fixture();
  try {
    for (const method of ["GET", "HEAD"] as const) {
      assert.equal((await app.inject({ method, url: "/health" })).statusCode, 200);
    }
    for (const url of ["/health/", "/health/extra", "/missing", "/test/read"]) {
      assert.equal((await app.inject(url)).statusCode, 401);
    }
    for (const method of ["OPTIONS", "POST", "DELETE"] as const) {
      assert.equal((await app.inject({ method, url: "/health" })).statusCode, 401);
    }
  } finally {
    await app.close();
  }
});

void test("bad credentials and revoked credentials have identical safe responses and logs", async () => {
  const { app, read, store, logs } = fixture();
  store.revoke("api-read");
  const unknown = `udt_${"a".repeat(43)}`;
  try {
    let expected: string | undefined;
    for (const header of [
      undefined,
      "Basic secret",
      "Bearer short",
      `Bearer ${unknown}`,
      `Bearer ${read}`,
      `Bearer ${read} extra`,
    ]) {
      const response = await app.inject({
        url: "/test/read",
        ...(header === undefined ? {} : { headers: { authorization: header } }),
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers["www-authenticate"], "Bearer");
      expected ??= response.body;
      assert.equal(response.body, expected);
    }
    const output = logs.join("");
    for (const secret of [read, unknown, "Basic secret", "unused-dokploy-key"])
      assert.ok(!output.includes(secret));
  } finally {
    await app.close();
  }
});

void test("verified caller identity and capabilities govern reads and mutations", async () => {
  const { app, read, manage, store } = fixture();
  try {
    for (const [token, capability, name] of [
      [read, "read", "api-read"],
      [manage, "manage", "api-manage"],
    ]) {
      const headers = { authorization: `bearer ${token}` };
      const response = await app.inject({ url: "/test/read", headers });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        id: store.list().find((item) => item.name === name)?.id,
        name,
        capability,
      });
      assert.equal((await app.inject({ url: "/test/explicit-read", headers })).statusCode, 200);
      assert.equal(
        (await app.inject({ url: "/test/manage", headers })).statusCode,
        capability === "manage" ? 200 : 403,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/test/write",
            headers,
            payload: { value: "okay" },
          })
        ).statusCode,
        capability === "manage" ? 200 : 403,
      );
      assert.equal((await app.inject({ url: "/missing", headers })).statusCode, 404);
    }
    store.revoke("api-manage");
    assert.equal(
      (await app.inject({ url: "/test/read", headers: { authorization: `Bearer ${manage}` } }))
        .statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});

void test("authentication precedes body parsing and store failures are sanitized 500s", async () => {
  const { app, store, read, logs } = fixture();
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/test/write",
          headers: { "content-type": "application/json" },
          payload: "{broken",
        })
      ).statusCode,
      401,
    );
    store.authenticate = () => {
      throw new Error(`database failed ${read}`);
    };
    const response = await app.inject({
      url: "/test/read",
      headers: { authorization: `Bearer ${read}` },
    });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json<{ error: { code: string } }>().error.code, "INTERNAL_ERROR");
    assert.ok(!response.body.includes(read));
    assert.ok(!logs.join("").includes(read));
  } finally {
    await app.close();
  }
});

void test("capability hook fails closed without an authenticated caller", async () => {
  const handler = requireDeployCapability("read");
  let status = 0;
  const reply = {
    header: () => reply,
    status: (value: number) => {
      status = value;
      return reply;
    },
    send: () => reply,
  };
  await handler(
    { serviceCaller: null } as Parameters<typeof handler>[0],
    reply as unknown as Parameters<typeof handler>[1],
  );
  assert.equal(status, 401);
});

void test("one peer budget bounds authenticated and unmatched requests before token lookup", async () => {
  const { app, store, read } = fixture();
  const authenticate = store.authenticate.bind(store);
  let lookups = 0;
  store.authenticate = (token) => {
    lookups += 1;
    return authenticate(token);
  };
  try {
    for (let index = 0; index < 60; index += 1) {
      const matched = index % 2 === 0;
      const response = await app.inject({
        url: matched ? "/test/read" : `/missing-${String(index)}`,
        headers: { authorization: `Bearer ${read}`, "x-forwarded-for": `192.0.2.${String(index)}` },
      });
      assert.equal(response.statusCode, matched ? 200 : 404);
    }
    assert.equal(lookups, 60);
    const response = await app.inject({
      method: "POST",
      url: "/test/write",
      headers: {
        authorization: `Bearer ${read}`,
        "content-type": "application/json",
      },
      payload: "{broken",
    });
    assert.equal(response.statusCode, 429);
    assert.deepEqual(response.json(), {
      error: { code: "RATE_LIMITED", message: "Too many requests" },
    });
    assert.ok(Number(response.headers["retry-after"]) > 0);
    assert.equal(
      lookups,
      60,
      "limited requests cannot authenticate or update last-used timestamps",
    );
    assert.equal(
      (
        await app.inject({
          url: "/test/read",
          remoteAddress: "192.0.2.200",
          headers: { authorization: `Bearer ${read}` },
        })
      ).statusCode,
      200,
    );
    assert.equal(lookups, 61);
  } finally {
    await app.close();
  }
});

void test("unknown credentials cannot bypass the peer limit by changing URL or token", async () => {
  const { app, store } = fixture();
  const authenticate = store.authenticate.bind(store);
  let lookups = 0;
  store.authenticate = (token) => {
    lookups += 1;
    return authenticate(token);
  };
  try {
    for (let index = 0; index < 60; index += 1) {
      const response = await app.inject({
        url: `/unknown-${String(index)}`,
        headers: { authorization: `Bearer udt_${String(index).padStart(43, "a")}` },
      });
      assert.equal(response.statusCode, 401);
    }
    assert.equal((await app.inject("/another-unknown-url")).statusCode, 429);
    assert.equal(lookups, 60);
  } finally {
    await app.close();
  }
});

void test("anonymous health requests consume the same bounded peer budget", async () => {
  const { app } = fixture();
  try {
    for (let index = 0; index < 60; index += 1) {
      assert.equal((await app.inject("/health")).statusCode, 200);
    }
    assert.equal((await app.inject("/health")).statusCode, 429);
    assert.equal((await app.inject("/test/read")).statusCode, 429);
    assert.equal(
      (await app.inject({ url: "/health", remoteAddress: "192.0.2.200" })).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});
