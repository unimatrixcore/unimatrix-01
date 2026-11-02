import { hostHeaderValidation, originValidation } from "@modelcontextprotocol/fastify";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { hasServiceCapability, type ServicePrincipal } from "@unimatrix/auth";
import { AuthError, type ServiceCallerVerifier } from "@unimatrix/auth/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { createToolServer, type McpServerOptions } from "./server.js";

export interface McpRoutesOptions extends McpServerOptions {
  resource: string;
  authorizationServers: readonly string[];
  requiredCapabilities: readonly string[];
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  verifyOAuthCaller: ServiceCallerVerifier["verifyOAuthCaller"];
  allowInsecureLocalhost?: boolean;
  maxRequestBytes?: number;
}

const scopeSchema = z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/);
const configurationSchema = z.object({
  resource: z.url(),
  authorizationServers: z.array(z.url()).min(1),
  requiredCapabilities: z.array(scopeSchema).min(1),
  allowedHosts: z.array(z.string().min(1)).min(1),
  allowedOrigins: z.array(z.string().min(1)).min(1),
  allowInsecureLocalhost: z.boolean().default(false),
  maxRequestBytes: z.number().int().positive().default(1_048_576),
});

function safeUrl(value: string, allowLocalhost: boolean): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(allowLocalhost && loopback && url.protocol === "http:"))
  ) {
    throw new Error("MCP URLs must use HTTPS without credentials, query or fragment");
  }
  return url;
}

export function registerMcpRoutes(app: FastifyInstance, options: McpRoutesOptions): void {
  const config = configurationSchema.parse(options);
  const resource = safeUrl(config.resource, config.allowInsecureLocalhost);
  if (resource.pathname !== "/mcp") throw new Error("MCP resource must use the /mcp path");
  const authorizationServers = config.authorizationServers.map((value) => {
    safeUrl(value, false);
    return value;
  });
  const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", resource).href;
  const requiredCapabilities = config.requiredCapabilities;
  const supportedCapabilities = z
    .array(scopeSchema)
    .parse([
      ...new Set([...requiredCapabilities, ...options.tools.flatMap((tool) => tool.capabilities)]),
    ]);
  const principals = new WeakMap<FastifyRequest, ServicePrincipal>();
  const guards = [
    hostHeaderValidation(config.allowedHosts),
    originValidation(config.allowedOrigins),
  ];

  function reject(reply: FastifyReply, status: 401 | 403, error?: "invalid_token"): void {
    const challenge = [
      `Bearer resource_metadata="${resourceMetadataUrl}"`,
      `scope="${requiredCapabilities.join(" ")}"`,
    ];
    if (status === 403) challenge.push('error="insufficient_scope"');
    else if (error) challenge.push(`error="${error}"`);
    void reply
      .header("WWW-Authenticate", challenge.join(", "))
      .header("Cache-Control", "no-store")
      .code(status)
      .send({ error: status === 401 ? "unauthorized" : "forbidden" });
  }

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const authorization = request.headers.authorization;
    if (authorization === undefined) {
      reject(reply, 401);
      return;
    }
    const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization);
    if (!match?.[1]) {
      reject(reply, 401, "invalid_token");
      return;
    }
    try {
      const principal = await options.verifyOAuthCaller(match[1], requiredCapabilities);
      if (principal.credentialKind !== "oauth_token" || principal.resource !== resource.href) {
        reject(reply, 401, "invalid_token");
        return;
      }
      if (!requiredCapabilities.every((scope) => hasServiceCapability(principal, scope))) {
        reject(reply, 403);
        return;
      }
      principals.set(request, principal);
      Object.assign(request.raw, {
        auth: {
          token: match[1],
          clientId: principal.clientId ?? principal.credentialId,
          scopes: [...principal.capabilities],
          resource,
          resourceMetadataUrl,
          extra: { principal },
        },
      });
    } catch (error) {
      reject(
        reply,
        error instanceof AuthError && error.statusCode === 403 ? 403 : 401,
        "invalid_token",
      );
    }
  }

  const metadata = {
    resource: resource.href,
    authorization_servers: authorizationServers,
    scopes_supported: supportedCapabilities,
    bearer_methods_supported: ["header"],
  };
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    app.get(path, { onRequest: guards }, async (_request, reply) => {
      return reply.header("Cache-Control", "no-store").send(metadata);
    });
  }

  app.all(
    "/mcp",
    { onRequest: [...guards, authenticate], bodyLimit: config.maxRequestBytes },
    async (request, reply) => {
      const principal = principals.get(request);
      if (!principal) {
        reject(reply, 401, "invalid_token");
        return;
      }
      const handler = createMcpHandler(({ authInfo }) => {
        if (authInfo?.extra?.principal !== principal)
          throw new Error("MCP principal handoff failed");
        return createToolServer(options, principal);
      });
      reply.hijack();
      try {
        await toNodeHandler(handler)(
          Object.assign(request.raw, { method: request.method, url: request.url }),
          reply.raw,
          request.body,
        );
      } finally {
        await handler.close();
      }
    },
  );
}
