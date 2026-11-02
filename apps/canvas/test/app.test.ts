import assert from "node:assert/strict";
import { request, type IncomingHttpHeaders } from "node:http";
import test from "node:test";
import type { ServicePrincipal } from "@unimatrix/auth";
import { AuthError, type ServiceCallerVerifier } from "@unimatrix/auth/server";
import { canvasSyntheticCoursesSchema, canvasSyntheticStatusSchema } from "@unimatrix/shared";

import { buildApp } from "../src/app.js";
import { loadCanvasConfig } from "../src/config.js";

const config = loadCanvasConfig({
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
  const app = buildApp(config, { verifier, logger: false });
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
  return { send, mcp, records, calls, failures };
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
  void test(`HTTP and MCP return equivalent synthetic facts (modern protocol: ${modern})`, async (t) => {
    const { send, mcp } = await fixture(t);
    for (const [path, name, schema] of [
      ["/api/v1/status", "canvas_status", canvasSyntheticStatusSchema],
      ["/api/v1/courses", "canvas_list_courses", canvasSyntheticCoursesSchema],
    ] as const) {
      const http = await send(path, "api-full");
      assert.equal(http.status, 200);
      const facts = schema.parse(decoded(http));
      const response = await mcp("tools/call", { name, arguments: {} }, "oauth-full", modern);
      assert.deepEqual(result(response).structuredContent, facts);
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
    ["canvas_list_courses"],
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
