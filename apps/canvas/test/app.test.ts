import assert from "node:assert/strict";
import { request, type IncomingHttpHeaders } from "node:http";
import test from "node:test";
import { rootCertificates } from "node:tls";
import { createApiClient } from "@unimatrix/api-client";
import type { ServicePrincipal } from "@unimatrix/auth";
import { SecretValue, SecretsClientError } from "@unimatrix/secrets/client";
import { AuthError, type ServiceCallerVerifier } from "@unimatrix/auth/server";
import {
  canvasCoursesSchema,
  canvasConnectionStatusSchema,
  canvasCourseResponseSchema,
  canvasCoursesContract,
  canvasCourseContract,
} from "@unimatrix/shared";

import { buildApp } from "../src/app.js";
import { loadCanvasConfig } from "../src/config.js";

const config = loadCanvasConfig({
  CANVAS_USER_ID: "9007199254740993123",
  SECRETS_BASE_URL: "https://secrets:3001/",
  SECRETS_CANVAS_READ_TOKEN: "synthetic-canvas-store-reader",
  SECRETS_TLS_CERT_BASE64: Buffer.from(rootCertificates[0]!).toString("base64"),
  CANVAS_OWNER_USER_ID: "user_synthetic_owner",
  CANVAS_RESOURCE_URL: "https://canvas.example/mcp",
  CANVAS_ALLOWED_HOSTS: "canvas.example,127.0.0.1",
  CANVAS_ALLOWED_ORIGINS: "client.example",
  CLERK_SECRET_KEY: "sk_test_synthetic",
  CLERK_PUBLISHABLE_KEY: "pk_test_synthetic",
  CLERK_JWT_KEY: "synthetic-public-key",
  CLERK_ISSUER: "https://identity.example",
});

interface Response {
  status: number | undefined;
  headers: IncomingHttpHeaders;
  text: string;
}

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }) {
  const records = new Map<string, ServicePrincipal>();
  const failures = new Map<string, Error>();
  const calls: Array<{ kind: string; token: string; required: readonly string[] }> = [];
  for (const [token, credentialKind] of [
    ["api-full", "api_key"],
    ["oauth-full", "oauth_token"],
  ] as const) {
    records.set(token, {
      credentialKind,
      userId: config.ownerUserId,
      credentialId: token,
      clientId: credentialKind === "oauth_token" ? "synthetic-client" : null,
      resource: config.resource,
      capabilities: ["canvas:read", "canvas:status", "synthetic:echo"],
    });
  }
  const verify =
    (kind: ServicePrincipal["credentialKind"]) =>
    (token: string, required: readonly string[]): Promise<ServicePrincipal> => {
      calls.push({ kind, token, required });
      const failure = failures.get(token);
      if (failure) return Promise.reject(failure);
      const principal = records.get(token);
      if (
        !principal ||
        principal.credentialKind !== kind ||
        principal.resource !== config.resource
      ) {
        return Promise.reject(new AuthError({ kind: "unauthorized" }));
      }
      if (
        principal.userId !== config.ownerUserId ||
        required.some((scope) => !principal.capabilities.includes(scope))
      ) {
        return Promise.reject(new AuthError({ kind: "forbidden" }));
      }
      return Promise.resolve(principal);
    };
  const verifier: ServiceCallerVerifier = {
    verifyApiKeyCaller: verify("api_key"),
    verifyOAuthCaller: verify("oauth_token"),
  };
  const store = {
    value: "synthetic-canvas-token",
    failure: null as Error | null,
    reads: [] as string[],
  };
  const upstream = {
    id: config.canvasUserId,
    status: 200,
    calls: 0,
    empty: false,
    courseStatus: 200,
    enrollmentStatus: 200,
    paths: [] as string[],
  };
  const course = {
    id: "41",
    name: "Synthetic Astrobiology",
    course_code: "AST-101",
    time_zone: "America/Phoenix",
    workflow_state: "available",
  };
  const concludedCourse = {
    ...course,
    id: "42",
    name: "Synthetic concluded course",
    workflow_state: "completed",
  };
  const app = buildApp(config, {
    verifier,
    logger: false,
    secretsClient: {
      getSecretValue: (name) => {
        store.reads.push(name);
        if (store.failure) return Promise.reject(store.failure);
        return Promise.resolve(new SecretValue(store.value));
      },
    },
    canvasFetch: (url, init) => {
      upstream.calls++;
      const address = new URL(url instanceof Request ? url.url : url.toString());
      upstream.paths.push(address.pathname);
      assert.equal(address.origin, "https://learn.maricopa.edu");
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${store.value}`);
      let body: unknown;
      let status = upstream.status;
      if (address.pathname === "/api/v1/users/self") body = { id: upstream.id };
      else if (address.pathname === "/api/v1/users/self/enrollments") {
        status = upstream.enrollmentStatus;
        body = upstream.empty
          ? []
          : [
              {
                id: "81",
                course_id: "41",
                user_id: upstream.id,
                type: "StudentEnrollment",
                enrollment_state: "active",
              },
              {
                id: "82",
                course_id: "42",
                user_id: upstream.id,
                type: "StudentEnrollment",
                enrollment_state: "completed",
              },
            ];
      } else if (address.pathname === "/api/v1/courses") {
        body = upstream.empty
          ? []
          : [
              address.searchParams.get("enrollment_state") === "completed"
                ? concludedCourse
                : course,
            ];
      } else if (/^\/api\/v1\/courses\/(41|42)$/u.test(address.pathname)) {
        status = upstream.courseStatus;
        body = address.pathname.endsWith("42") ? concludedCourse : course;
      } else throw new Error(`Unexpected upstream path: ${address.pathname}`);
      return Promise.resolve(new globalThis.Response(JSON.stringify(body), { status }));
    },
  });
  t.after(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;

  async function send(
    path: string,
    token?: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: body === undefined ? "GET" : "POST",
          headers: {
            host: "canvas.example",
            accept: "application/json, text/event-stream",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...extraHeaders,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            resolve({
              status: response.statusCode,
              headers: response.headers,
              text: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function mcp(
    method: string,
    params: Record<string, unknown> = {},
    token?: string,
    modern = false,
  ) {
    return send(
      "/mcp",
      token,
      {
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          ...(modern
            ? {
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                  "io.modelcontextprotocol/clientCapabilities": {},
                  "io.modelcontextprotocol/clientInfo": {
                    name: "canvas-socket-test",
                    version: "1.0.0",
                  },
                },
              }
            : {}),
        },
      },
      modern
        ? {
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": method,
            ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
          }
        : {},
    );
  }
  return { app, send, mcp, records, calls, failures, store, upstream, course };
}

function decoded(response: Response): unknown {
  const data = response.text.startsWith("event:")
    ? response.text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : response.text;
  return JSON.parse(data ?? "null") as unknown;
}

function result(response: Response): Record<string, unknown> {
  assert.equal(response.status, 200, response.text);
  const body = decoded(response) as { result: Record<string, unknown> };
  assert.ok(body.result, response.text);
  return body.result;
}

void test("HTTP and MCP share a peer budget before verification without trusting forwarded IPs", async (t) => {
  const { app, send, mcp, calls } = await fixture(t);
  assert.equal((await send("/health")).status, 200);
  for (let index = 0; index < 60; index++) {
    const response =
      index % 2 === 0
        ? await send("/api/v1/courses", "api-full")
        : await mcp("tools/list", {}, "oauth-full");
    assert.equal(response.status, 200);
  }
  assert.equal(calls.length, 60);
  for (const path of ["/api/v1/status", "/api/v1/courses"]) {
    const denied = await send(path, "api-full", undefined, {
      "x-forwarded-for": "192.0.2.99",
    });
    assert.equal(denied.status, 429);
    assert.match(denied.text, /RATE_LIMITED/);
    assert.ok(Number(denied.headers["retry-after"]) > 0);
    assert.ok(denied.headers["x-request-id"]);
    assert.equal(denied.headers["cache-control"], "no-store");
    assert.ok(!denied.text.includes("api-full"));
  }
  assert.equal((await mcp("tools/list", {}, "oauth-full")).status, 429);
  assert.equal(calls.length, 60);
  const anotherPeer = await app.inject({
    method: "GET",
    url: "/api/v1/courses",
    remoteAddress: "192.0.2.2",
    headers: { host: "canvas.example", authorization: "Bearer api-full" },
  });
  assert.equal(anotherPeer.statusCode, 200);
  assert.equal(calls.length, 61);
  assert.equal((await send("/health")).status, 200);
});

void test("failed callers spend the budget and exhaustion precedes body parsing", async (t) => {
  const { send, mcp, calls } = await fixture(t);
  for (let index = 0; index < 60; index++) {
    const response =
      index % 2 === 0
        ? await send("/api/v1/courses", "invalid")
        : await mcp("tools/list", {}, "invalid");
    assert.equal(response.status, 401);
  }
  assert.equal(calls.length, 60);
  const oversized = await send("/mcp", "oauth-full", "private-marker".repeat(6000));
  assert.equal(oversized.status, 429);
  assert.ok(!oversized.text.includes("private-marker"));
  assert.equal((await send("/api/v1/status")).status, 429);
  assert.equal(calls.length, 60);
});

void test("anonymous liveness and fixed discovery expose no detailed status", async (t) => {
  const { send, mcp, calls } = await fixture(t);
  assert.deepEqual(decoded(await send("/health")), { status: "ok" });
  const metadata = await send("/.well-known/oauth-protected-resource", undefined, undefined, {
    "x-forwarded-host": "attacker.example",
  });
  assert.equal(metadata.status, 200);
  assert.equal((decoded(metadata) as { resource: string }).resource, config.resource);
  for (const path of ["/api/v1/status", "/api/v1/courses"]) {
    const response = await send(path);
    assert.equal(response.status, 401);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.ok(response.headers["x-request-id"]);
    assert.ok(!response.text.includes("Synthetic Astrobiology"));
  }
  const protectedCatalog = await mcp("tools/list");
  assert.equal(protectedCatalog.status, 401);
  assert.match(String(protectedCatalog.headers["www-authenticate"]), /resource_metadata=/);
  assert.equal(calls.length, 0);
});

for (const modern of [false, true]) {
  void test(`HTTP and MCP return equivalent verified facts (modern protocol: ${modern})`, async (t) => {
    const { send, mcp } = await fixture(t);
    for (const [path, name, schema] of [
      ["/api/v1/status", "canvas_status", canvasConnectionStatusSchema],
      ["/api/v1/courses", "canvas_list_courses", canvasCoursesSchema],
    ] as const) {
      const http = await send(path, "api-full");
      assert.equal(http.status, 200);
      const facts = schema.parse(decoded(http));
      const response = await mcp("tools/call", { name, arguments: {} }, "oauth-full", modern);
      const toolFacts = schema.parse(result(response).structuredContent);
      if ("courses" in facts && "courses" in toolFacts) {
        assert.deepEqual(toolFacts.courses, facts.courses);
        assert.deepEqual(
          toolFacts.sources.map(({ coverage, source, sourceLinks, warnings }) => ({
            coverage,
            source,
            sourceLinks,
            warnings,
          })),
          facts.sources.map(({ coverage, source, sourceLinks, warnings }) => ({
            coverage,
            source,
            sourceLinks,
            warnings,
          })),
        );
      } else assert.deepEqual(toolFacts, facts);
      assert.equal(response.headers["mcp-session-id"], undefined);
    }
    const echo = result(
      await mcp(
        "tools/call",
        { name: "synthetic_echo", arguments: { message: "independent synthetic tool" } },
        "oauth-full",
        modern,
      ),
    );
    assert.deepEqual(echo.structuredContent, { message: "independent synthetic tool" });
    const invalid = result(
      await mcp(
        "tools/call",
        { name: "synthetic_echo", arguments: { message: "x".repeat(257) } },
        "oauth-full",
        modern,
      ),
    );
    assert.equal(invalid.isError, true);
  });
}

void test("keeps API-key and OAuth callers separate over real sockets", async (t) => {
  const { send, mcp, calls } = await fixture(t);
  assert.equal((await send("/api/v1/courses", "oauth-full")).status, 401);
  assert.equal((await mcp("tools/list", {}, "api-full")).status, 401);
  assert.deepEqual(
    calls.map(({ kind }) => kind),
    ["api_key", "oauth_token"],
  );
});

void test("malformed bearer headers fail before verification", async (t) => {
  const { send, calls } = await fixture(t);
  for (const authorization of [
    "Basic private",
    "Bearer",
    "Bearer contains spaces",
    "Bearer private\tvalue",
  ]) {
    assert.equal(
      (await send("/api/v1/courses", undefined, undefined, { authorization })).status,
      401,
    );
  }
  assert.equal(calls.length, 0);
});

void test("unexpected failures and unmatched URLs return safe correlated errors", async (t) => {
  const { send, failures } = await fixture(t);
  const privateValue = "private-upstream-token-123";
  failures.set("broken", new Error(`Provider rejected ${privateValue}`));
  const error = await send("/api/v1/courses", "broken");
  assert.equal(error.status, 500);
  assert.ok(!error.text.includes(privateValue));
  assert.ok(!error.text.includes("Provider rejected"));
  assert.match(error.text, /INTERNAL_ERROR/);
  assert.ok(error.headers["x-request-id"]);
  const missing = await send(`/not-found?credential=${privateValue}`);
  assert.equal(missing.status, 404);
  assert.ok(!missing.text.includes(privateValue));
  assert.ok(!missing.text.includes("not-found"));
  assert.match(missing.text, /NOT_FOUND/);
});

void test("oversized request bodies are rejected without reflecting content", async (t) => {
  const { send } = await fixture(t);
  const privateValue = "private-body-marker";
  const response = await send("/mcp", "oauth-full", { message: privateValue.repeat(5000) });
  assert.equal(response.status, 413);
  assert.ok(!response.text.includes(privateValue));
});

void test("unsupported media types retain a safe client-error response", async (t) => {
  const { send } = await fixture(t);
  const mediaType = "application/x-private-marker";
  const response = await send(
    "/mcp",
    "oauth-full",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { "content-type": mediaType },
  );
  assert.equal(response.status, 415);
  assert.match(response.text, /INVALID_REQUEST/);
  assert.ok(!response.text.includes(mediaType));
  assert.ok(!response.text.includes("FST_ERR_CTP_INVALID_MEDIA_TYPE"));
  assert.ok(response.headers["x-request-id"]);
});

void test("honors injected verifier denials and rechecks credentials for every request", async (t) => {
  const { send, mcp, records, calls } = await fixture(t);
  const base = records.get("api-full");
  assert.ok(base);
  records.set("wrong-owner", { ...base, userId: "user_someone_else" });
  records.set("wrong-resource", { ...base, resource: "https://other.example/mcp" });
  records.set("read-only", { ...base, capabilities: ["canvas:read"] });
  assert.equal((await send("/api/v1/courses", "wrong-owner")).status, 403);
  assert.equal((await send("/api/v1/courses", "wrong-resource")).status, 401);
  assert.equal((await send("/api/v1/status", "read-only")).status, 403);
  assert.equal((await send("/api/v1/courses", "read-only")).status, 200);
  assert.equal((await send("/api/v1/courses", "api-full")).status, 200);
  records.delete("api-full");
  assert.equal((await send("/api/v1/courses", "api-full")).status, 401);
  assert.equal((await mcp("tools/list", {}, "oauth-full")).status, 200);
  records.delete("oauth-full");
  assert.equal((await mcp("tools/list", {}, "oauth-full")).status, 401);
  assert.equal(calls.filter(({ token }) => token === "api-full").length, 2);
});

void test("capabilities filter MCP discovery and deny unavailable tools", async (t) => {
  const { mcp, records } = await fixture(t);
  const base = records.get("oauth-full");
  assert.ok(base);
  records.set("oauth-read", { ...base, capabilities: ["canvas:read"] });
  const catalog = result(await mcp("tools/list", {}, "oauth-read"));
  assert.deepEqual(
    (catalog.tools as Array<{ name: string }>).map(({ name }) => name),
    ["canvas_list_courses", "canvas_get_course"],
  );
  const denied = await mcp("tools/call", { name: "canvas_status", arguments: {} }, "oauth-read");
  assert.ok(!denied.text.includes('"connection":"synthetic"'));
  const body = decoded(denied) as { error?: unknown; result?: { isError?: boolean } };
  assert.ok(body.error || body.result?.isError);
});

void test("rejects untrusted MCP hosts and origins while admitting clients without Origin", async (t) => {
  const { send, mcp } = await fixture(t);
  const payload = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  assert.equal(
    (
      await send("/mcp", "oauth-full", payload, {
        host: "attacker.example",
        "x-forwarded-host": "canvas.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (await send("/mcp", "oauth-full", payload, { origin: "https://attacker.example" })).status,
    403,
  );
  assert.equal((await mcp("tools/list", {}, "oauth-full")).status, 200);
});

void test("connection status rereads the Admin credential through HTTP and MCP", async (t) => {
  const { send, mcp, store, upstream } = await fixture(t);
  assert.equal((await send("/api/v1/connection")).status, 401);
  assert.equal(store.reads.length, 0);
  assert.deepEqual(decoded(await send("/api/v1/connection", "api-full")), {
    connection: "connected",
  });
  store.value = "replacement-canvas-token";
  const response = result(
    await mcp("tools/call", { name: "canvas_connection_status", arguments: {} }, "oauth-full"),
  );
  assert.deepEqual(response.structuredContent, { connection: "connected" });
  assert.deepEqual(store.reads, [
    "integrations/canvas/access-token",
    "integrations/canvas/access-token",
  ]);
  assert.equal(upstream.calls, 2);
  upstream.id = "9007199254740993999";
  const mismatch = await send("/api/v1/connection", "api-full");
  assert.equal(mismatch.status, 409);
  assert.match(mismatch.text, /CANVAS_ACCOUNT_MISMATCH/);
  assert.ok(!mismatch.text.includes(store.value));
  assert.ok(!mismatch.text.includes(upstream.id));
});

void test("store failures and upstream rejection remain distinct from caller auth and liveness", async (t) => {
  const { send, mcp, store, upstream } = await fixture(t);
  for (const [status, code] of [
    [403, "CREDENTIAL_DENIED"],
    [404, "CREDENTIAL_MISSING"],
    [500, "CREDENTIAL_UNAVAILABLE"],
  ] as const) {
    store.failure = new SecretsClientError("private-store-error", { status });
    const http = await send("/api/v1/connection", "api-full");
    assert.equal(http.status, 503);
    assert.match(http.text, new RegExp(code));
    const tool = result(
      await mcp("tools/call", { name: "canvas_connection_status", arguments: {} }, "oauth-full"),
    );
    assert.equal(tool.isError, true);
    assert.match(JSON.stringify(tool), new RegExp(code));
    for (const serialized of [http.text, JSON.stringify(tool)]) {
      assert.ok(!serialized.includes("private-store-error"));
      assert.ok(!serialized.includes(store.value));
    }
  }
  assert.equal(upstream.calls, 0);
  store.failure = null;
  for (const status of [401, 403]) {
    upstream.status = status;
    const rejected = await send("/api/v1/connection", "api-full");
    assert.equal(rejected.status, 502);
    assert.match(rejected.text, /CANVAS_CREDENTIAL_REJECTED/);
  }
  assert.deepEqual(decoded(await send("/health")), { status: "ok" });
});

void test("course detail facts and coverage agree through HTTP and MCP", async (t) => {
  const { send, mcp } = await fixture(t);
  for (const [courseId, concluded] of [
    ["41", false],
    ["42", true],
  ] as const) {
    const http = await send(
      `/api/v1/course?courseId=${courseId}&concluded=${concluded}`,
      "api-full",
    );
    assert.equal(http.status, 200, http.text);
    const facts = canvasCourseResponseSchema.parse(decoded(http));
    const tool = canvasCourseResponseSchema.parse(
      result(
        await mcp(
          "tools/call",
          { name: "canvas_get_course", arguments: { courseId, concluded } },
          "oauth-full",
        ),
      ).structuredContent,
    );
    assert.deepEqual(tool.course, facts.course);
    assert.equal(facts.course.enrollmentState, concluded ? "completed" : "active");
    assert.equal(facts.course.effectiveTimeZone, "America/Phoenix");
    assert.deepEqual(
      tool.sources.map(({ coverage }) => coverage),
      facts.sources.map(({ coverage }) => coverage),
    );
  }
});

void test("unverified and concluded course identifiers fail closed through both interfaces", async (t) => {
  const { send, mcp, upstream } = await fixture(t);
  for (const courseId of ["999", "42"]) {
    const http = await send(`/api/v1/course?courseId=${courseId}`, "api-full");
    assert.ok(http.status && http.status >= 400, http.text);
    const code = (decoded(http) as { error: { code: string } }).error.code;
    const tool = result(
      await mcp("tools/call", { name: "canvas_get_course", arguments: { courseId } }, "oauth-full"),
    );
    assert.equal(tool.isError, true);
    assert.ok(JSON.stringify(tool).includes(code));
    assert.ok(!upstream.paths.includes(`/api/v1/courses/${courseId}`));
  }
});

void test("empty verified enrollments return an explicitly complete empty list", async (t) => {
  const { send, mcp, upstream } = await fixture(t);
  upstream.empty = true;
  const http = await send("/api/v1/courses", "api-full");
  assert.equal(http.status, 200, http.text);
  const facts = canvasCoursesSchema.parse(decoded(http));
  assert.deepEqual(facts.courses, []);
  assert.ok(facts.sources.every(({ coverage }) => coverage === "complete"));
  const tool = canvasCoursesSchema.parse(
    result(await mcp("tools/call", { name: "canvas_list_courses", arguments: {} }, "oauth-full"))
      .structuredContent,
  );
  assert.deepEqual(tool.courses, []);
  assert.deepEqual(
    tool.sources.map(({ coverage }) => coverage),
    facts.sources.map(({ coverage }) => coverage),
  );
});

void test("bounded shared queries reject invalid HTTP and MCP selectors", async (t) => {
  const { send, mcp, upstream } = await fixture(t);
  for (const [path, name, args] of [
    ["/api/v1/courses?concluded=no", "canvas_list_courses", { concluded: "no" }],
    ["/api/v1/courses?limit=101", "canvas_list_courses", { limit: 101 }],
    ["/api/v1/courses?cursor=bad", "canvas_list_courses", { cursor: "bad" }],
    ["/api/v1/courses?caller=other", "canvas_list_courses", { caller: "other" }],
    ["/api/v1/course?courseId=0", "canvas_get_course", { courseId: "0" }],
    [
      "/api/v1/course?courseId=41&userId=other",
      "canvas_get_course",
      { courseId: "41", userId: "other" },
    ],
  ] as const) {
    assert.equal((await send(path, "api-full")).status, 400);
    assert.equal(
      result(await mcp("tools/call", { name, arguments: args }, "oauth-full")).isError,
      true,
    );
  }
  assert.equal(upstream.calls, 0);
});

void test("generic API-client requests consume the shared course contracts", async (t) => {
  const { app } = await fixture(t);
  const client = createApiClient({
    baseUrl: "http://canvas.example",
    getAuthToken: () => "api-full",
    fetch: async (input, init) => {
      const response = await app.inject({
        method: "GET",
        url: new URL(input).pathname + new URL(input).search,
        headers: { ...init?.headers, host: "canvas.example" },
      });
      return {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        json: () => Promise.resolve<unknown>(response.json()),
        text: () => Promise.resolve(response.body),
      };
    },
  });
  const list = await client.request(canvasCoursesContract, {
    query: { concluded: true, limit: 1 },
  });
  assert.equal(list.courses.length, 1);
  const detail = await client.request(canvasCourseContract, { query: { courseId: "41" } });
  assert.equal(detail.course.id, "41");
});

void test("oversized course facts fail identically before the MCP host output limit", async (t) => {
  const { send, mcp, course } = await fixture(t);
  course.name = "private-course-text".repeat(2500);
  for (const [path, name, args] of [
    ["/api/v1/course?courseId=41", "canvas_get_course", { courseId: "41" }],
    ["/api/v1/courses", "canvas_list_courses", {}],
  ] as const) {
    const http = await send(path, "api-full");
    assert.equal(http.status, 503);
    assert.match(http.text, /CANVAS_BUDGET_EXHAUSTED/);
    const tool = result(await mcp("tools/call", { name, arguments: args }, "oauth-full"));
    assert.equal(tool.isError, true);
    assert.match(JSON.stringify(tool), /CANVAS_BUDGET_EXHAUSTED/);
    assert.ok(!http.text.includes("private-course-text"));
    assert.ok(!JSON.stringify(tool).includes("private-course-text"));
  }
});

void test("HTTP continuation resumes through MCP with the same verified owner and filters", async (t) => {
  const { send, mcp } = await fixture(t);
  const http = await send("/api/v1/courses?concluded=true&limit=1", "api-full");
  assert.equal(http.status, 200, http.text);
  let page = canvasCoursesSchema.parse(decoded(http));
  const ids = page.courses.map(({ id }) => id);
  assert.ok(page.continuation);
  assert.ok(page.sources.some(({ coverage }) => coverage === "partial"));
  for (let index = 0; page.continuation && index < 4; index++) {
    page = canvasCoursesSchema.parse(
      result(
        await mcp(
          "tools/call",
          {
            name: "canvas_list_courses",
            arguments: { concluded: true, limit: 1, cursor: page.continuation },
          },
          "oauth-full",
        ),
      ).structuredContent,
    );
    ids.push(...page.courses.map(({ id }) => id));
  }
  assert.equal(page.continuation, undefined);
  assert.deepEqual(ids, ["41", "42"]);
  assert.ok(page.sources.every(({ coverage }) => coverage === "complete"));
});

void test("inaccessible memberships and course resources preserve HTTP and MCP error parity", async (t) => {
  const { send, mcp, upstream } = await fixture(t);
  for (const failure of ["enrollmentStatus", "courseStatus"] as const) {
    upstream[failure] = 403;
    const http = await send("/api/v1/course?courseId=41&fresh=true", "api-full");
    assert.equal(http.status, 502, http.text);
    const code = (decoded(http) as { error: { code: string } }).error.code;
    assert.equal(code, "CANVAS_RESOURCE_UNAVAILABLE");
    const tool = result(
      await mcp(
        "tools/call",
        { name: "canvas_get_course", arguments: { courseId: "41", fresh: true } },
        "oauth-full",
      ),
    );
    assert.equal(tool.isError, true);
    assert.ok(JSON.stringify(tool).includes(code));
    upstream[failure] = 200;
  }
});
