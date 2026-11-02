import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import type { ServicePrincipal } from "@unimatrix/auth";
import { AuthError } from "@unimatrix/auth/server";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { registerMcpRoutes, type McpRoutesOptions } from "../src/fastify.js";
import { defineTool } from "../src/server.js";

const resource = "https://tools.example/mcp";
const principal: ServicePrincipal = {
  credentialKind: "oauth_token",
  credentialId: "oauth_synthetic",
  clientId: "synthetic-client",
  userId: "owner_synthetic",
  resource,
  capabilities: ["tools:discover", "sample:read"],
};
const sampleTool = defineTool({
  name: "sample-read",
  description: "Read synthetic data",
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ userId: z.string(), message: z.string() }),
  capabilities: ["sample:read"],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execute: ({ message }, context) =>
    Promise.resolve({
      data: { userId: context.principal.userId, message },
      text: `${context.principal.userId}: ${message}`,
    }),
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface HttpResult {
  status: number | undefined;
  headers: IncomingHttpHeaders;
  text: string;
}

async function fixture(overrides: Partial<McpRoutesOptions> = {}) {
  const app = Fastify({ trustProxy: true });
  const verifyOAuthCaller = vi.fn(() => Promise.resolve(principal));
  const options: McpRoutesOptions = {
    name: "synthetic",
    version: "1.0.0",
    tools: [sampleTool],
    resource,
    authorizationServers: ["https://identity.example"],
    requiredCapabilities: ["tools:discover"],
    allowedHosts: ["tools.example", "127.0.0.1"],
    allowedOrigins: ["tools.example"],
    verifyOAuthCaller,
    ...overrides,
  };
  registerMcpRoutes(app, options);
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => app.close());
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test socket");
  const port = address.port;

  async function send(
    body?: unknown,
    headers: Record<string, string> = {},
    method = "POST",
    path = "/mcp",
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          headers: {
            host: "tools.example",
            accept: "application/json, text/event-stream",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            resolve({
              status: response.statusCode,
              headers: response.headers,
              text: Buffer.concat(chunks).toString("utf8"),
            });
          });
          response.on("error", reject);
        },
      );
      request.on("error", reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  return { app, address, send, verifyOAuthCaller };
}

function message(method: string, params?: Record<string, unknown>, modern = false): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      ...(modern
        ? {
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_CAPABILITIES_META_KEY]: {},
              [CLIENT_INFO_META_KEY]: { name: "socket-test", version: "1.0.0" },
            },
          }
        : {}),
    },
  };
}

function decoded(response: HttpResult): unknown {
  const data = response.text.startsWith("event:")
    ? response.text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : response.text;
  return JSON.parse(data ?? "null") as unknown;
}

describe("authenticated MCP HTTP routes", () => {
  it("serves anonymous metadata from fixed configuration despite forwarded headers", async () => {
    const { send, verifyOAuthCaller } = await fixture();
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const response = await send(
        undefined,
        { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" },
        "GET",
        path,
      );
      expect(response.status).toBe(200);
      expect(decoded(response)).toEqual({
        resource,
        authorization_servers: ["https://identity.example"],
        scopes_supported: ["tools:discover", "sample:read"],
        bearer_methods_supported: ["header"],
      });
    }
    expect(verifyOAuthCaller).not.toHaveBeenCalled();
  });

  it.each(["tools/list", "tools/call", "server/discover"])(
    "protects %s and advertises discovery without extra client headers",
    async (method) => {
      const { send, verifyOAuthCaller } = await fixture();
      const response = await send(message(method));
      expect(response.status).toBe(401);
      expect(response.headers["www-authenticate"]).toBe(
        'Bearer resource_metadata="https://tools.example/.well-known/oauth-protected-resource/mcp", scope="tools:discover"',
      );
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(verifyOAuthCaller).not.toHaveBeenCalled();
      expect(response.text).not.toContain("sample-read");
    },
  );

  it.each(["GET", "DELETE"])(
    "authenticates %s session operations before protocol handling",
    async (method) => {
      const { send } = await fixture();
      expect((await send(undefined, {}, method)).status).toBe(401);
      const response = await send(undefined, { authorization: "Bearer synthetic" }, method);
      expect(response.status).toBe(405);
      expect(response.headers["mcp-session-id"]).toBeUndefined();
    },
  );

  it.each([false, true])(
    "passes parsed JSON and verified principal over a socket (modern: %s)",
    async (modern) => {
      const { send, verifyOAuthCaller } = await fixture();
      const response = await send(
        message(
          "tools/call",
          { name: "sample-read", arguments: { message: "parsed input" } },
          modern,
        ),
        {
          authorization: "Bearer synthetic",
          ...(modern
            ? {
                "mcp-protocol-version": "2026-07-28",
                "mcp-method": "tools/call",
                "mcp-name": "sample-read",
              }
            : {}),
        },
      );
      expect(response.status).toBe(200);
      expect(decoded(response)).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: {
          structuredContent: { userId: "owner_synthetic", message: "parsed input" },
          content: [{ type: "text", text: "owner_synthetic: parsed input" }],
        },
      });
      expect(verifyOAuthCaller).toHaveBeenCalledWith("synthetic", ["tools:discover"]);
      expect(response.headers["mcp-session-id"]).toBeUndefined();
    },
  );

  it.each(["2025-03-26", "2025-06-18", "2025-11-25"])(
    "negotiates legacy protocol %s without persistent sessions",
    async (protocolVersion) => {
      const { send } = await fixture();
      const response = await send(
        message("initialize", {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "socket-test", version: "1.0" },
        }),
        { authorization: "Bearer synthetic" },
      );
      expect(response.status).toBe(200);
      expect(decoded(response)).toMatchObject({
        result: { protocolVersion, serverInfo: { name: "synthetic", version: "1.0.0" } },
      });
      expect(response.headers["mcp-session-id"]).toBeUndefined();
    },
  );

  it("serves modern discovery and rejects mismatched protocol headers", async () => {
    const { send } = await fixture();
    const response = await send(message("server/discover", {}, true), {
      authorization: "Bearer synthetic",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "server/discover",
    });
    expect(response.status).toBe(200);
    expect(decoded(response)).toMatchObject({
      result: {
        supportedVersions: ["2026-07-28"],
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "synthetic" } },
      },
    });
    const mismatch = await send(message("tools/list", {}, true), {
      authorization: "Bearer synthetic",
      "mcp-protocol-version": "2025-11-25",
      "mcp-method": "tools/list",
    });
    expect(mismatch.status).toBe(400);
    expect(decoded(mismatch)).toMatchObject({ error: { code: -32020 } });
  });

  it.each(["Basic synthetic", "Bearer", "Bearer synthetic extra", "Bearer syn\tthetic"])(
    "rejects malformed authorization %s",
    async (authorization) => {
      const { send, verifyOAuthCaller } = await fixture();
      const response = await send(message("tools/list"), { authorization });
      expect(response.status).toBe(401);
      expect(response.headers["www-authenticate"]).toContain('error="invalid_token"');
      expect(verifyOAuthCaller).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...principal, resource: "https://other.example/mcp" },
    { ...principal, credentialKind: "api_key" as const },
  ])("rejects an otherwise verified wrong resource or credential kind", async (caller) => {
    const { send } = await fixture({ verifyOAuthCaller: () => Promise.resolve(caller) });
    const response = await send(message("tools/list"), { authorization: "Bearer synthetic" });
    expect(response.status).toBe(401);
    expect(response.text).not.toContain("sample-read");
  });

  it("requires discovery capabilities and hides inaccessible tools from both listing and execution", async () => {
    const denied = await fixture({
      verifyOAuthCaller: () => Promise.resolve({ ...principal, capabilities: [] }),
    });
    const response = await denied.send(message("tools/list"), {
      authorization: "Bearer synthetic",
    });
    expect(response.status).toBe(403);
    expect(response.headers["www-authenticate"]).toContain('error="insufficient_scope"');
    const limited = await fixture({
      verifyOAuthCaller: () => Promise.resolve({ ...principal, capabilities: ["tools:discover"] }),
    });
    const catalog = await limited.send(message("tools/list"), {
      authorization: "Bearer synthetic",
    });
    expect(decoded(catalog)).toMatchObject({ error: { code: -32601 } });
    expect(catalog.text).not.toContain("sample-read");
    const call = await limited.send(
      message("tools/call", { name: "sample-read", arguments: { message: "private" } }),
      { authorization: "Bearer synthetic" },
    );
    expect(decoded(call)).toMatchObject({ error: { code: -32601 } });
    expect(call.text).not.toContain("owner_synthetic");
  });

  it.each([
    [new AuthError({ kind: "forbidden" }), 403],
    [new AuthError({ kind: "unauthorized" }), 401],
    [new Error("private-token-upstream-error"), 401],
  ] as const)("sanitizes verifier failures", async (error, status) => {
    const { send } = await fixture({
      verifyOAuthCaller: () => Promise.reject(error),
    });
    const response = await send(message("tools/list"), { authorization: "Bearer private-token" });
    expect(response.status).toBe(status);
    expect(response.text).not.toContain("private-token");
    expect(response.headers["www-authenticate"]).not.toContain("private-token");
  });

  it.each([
    { host: "attacker.example", "x-forwarded-host": "tools.example" },
    { origin: "https://attacker.example", "x-forwarded-host": "tools.example" },
    { origin: "null" },
    { origin: "malformed" },
  ])("rejects hostile Host and Origin independently of proxy trust", async (headers) => {
    const { send, verifyOAuthCaller } = await fixture();
    const response = await send(message("tools/list"), {
      authorization: "Bearer synthetic",
      ...headers,
    });
    expect(response.status).toBe(403);
    expect(verifyOAuthCaller).not.toHaveBeenCalled();
  });

  it("accepts an explicitly allowed browser Origin and bounds parsed request bodies", async () => {
    const { send } = await fixture({ maxRequestBytes: 256 });
    const response = await send(message("tools/list"), {
      authorization: "Bearer synthetic",
      origin: "https://tools.example:8443",
    });
    expect(response.status).toBe(200);
    const large = await send(
      message("tools/call", { name: "sample-read", arguments: { message: "x".repeat(300) } }),
      { authorization: "Bearer synthetic" },
    );
    expect(large.status).toBe(413);
  });

  it.each([
    { resource: "https://tools.example/other" },
    { resource: "http://tools.example/mcp", allowInsecureLocalhost: true },
    { resource: "http://127.0.0.1/mcp" },
    { resource: "https://user:password@tools.example/mcp" },
    { resource: "https://tools.example/mcp?token=private" },
    { resource: "https://tools.example/mcp#private" },
    { authorizationServers: ["http://identity.example"] },
    { authorizationServers: [] },
    { requiredCapabilities: [] },
    { requiredCapabilities: ['scope"injection'] },
    { allowedHosts: [] },
    { allowedOrigins: [] },
    { tools: [{ ...sampleTool, capabilities: ['scope"injection'] }] },
  ])("rejects unsafe host configuration before serving", async (overrides) => {
    await expect(fixture(overrides)).rejects.toThrow();
  });

  it("allows explicitly configured loopback HTTP development resources", async () => {
    const { send } = await fixture({
      resource: "http://127.0.0.1/mcp",
      allowInsecureLocalhost: true,
    });
    const response = await send(undefined, {}, "GET", "/.well-known/oauth-protected-resource/mcp");
    expect(decoded(response)).toMatchObject({ resource: "http://127.0.0.1/mcp" });
  });

  it("propagates a disconnected modern socket to the workflow AbortSignal", async () => {
    let started = false;
    let aborted = false;
    const waiting = defineTool({
      name: "wait",
      description: "Wait for cancellation",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      capabilities: ["sample:read"],
      annotations: { readOnlyHint: true },
      execute: async (_input, { signal }) => {
        started = true;
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return { data: {}, text: "cancelled" };
      },
    });
    const { address } = await fixture({ tools: [waiting] });
    const request = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path: "/mcp",
      method: "POST",
      headers: {
        host: "tools.example",
        authorization: "Bearer synthetic",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "wait",
      },
    });
    request.on("error", () => undefined);
    request.end(JSON.stringify(message("tools/call", { name: "wait", arguments: {} }, true)));
    await vi.waitFor(() => {
      expect(started).toBe(true);
    });
    request.destroy();
    await vi.waitFor(() => {
      expect(aborted).toBe(true);
    });
  });
});
