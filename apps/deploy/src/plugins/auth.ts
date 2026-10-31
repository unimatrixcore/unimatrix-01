import fastifyRateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { createAuthErrorEnvelope } from "../lib/http/errors.js";
import type { ServiceTokenStore, ServiceTokenSummary } from "../service-tokens/store.js";

export type DeployServiceCaller = Pick<ServiceTokenSummary, "id" | "name" | "capability">;

declare module "fastify" {
  interface FastifyRequest {
    serviceCaller: DeployServiceCaller | null;
  }
}

function deny(reply: FastifyReply, status: 401 | 403): FastifyReply {
  if (status === 401) reply.header("WWW-Authenticate", "Bearer");
  return reply.status(status).send(createAuthErrorEnvelope(status));
}

export function requireDeployCapability(capability: DeployServiceCaller["capability"]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const caller = request.serviceCaller;
    if (caller === null) {
      deny(reply, 401);
    } else if (capability === "manage" && caller.capability !== "manage") {
      deny(reply, 403);
    }
  };
}

export function setupServiceTokenAuth(app: FastifyInstance, store: ServiceTokenStore): void {
  app.decorateRequest("serviceCaller", null);
  app.register(fastifyRateLimit, { max: 60, timeWindow: "1 minute" });
  app.after(() => {
    // Instance hooks cover unmatched URLs too. Both hooks run before body parsing, with the
    // limiter first so rejected requests cannot spend a token lookup or database write.
    app.addHook("onRequest", app.rateLimit());
    app.addHook("onRequest", async (request, reply) => {
      if (
        request.routeOptions.url === "/health" &&
        (request.method === "GET" || request.method === "HEAD")
      )
        return;

      const header = request.headers.authorization;
      const match = header === undefined ? null : /^Bearer ([A-Za-z0-9_-]+)$/iu.exec(header);
      if (match === null) return deny(reply, 401);

      let token: ServiceTokenSummary | null;
      try {
        token = store.authenticate(match[1]!);
      } catch {
        // Database and validation errors cannot carry submitted credentials into the logger.
        throw new Error("Deploy caller authentication is unavailable.");
      }
      if (token === null) return deny(reply, 401);

      request.serviceCaller = { id: token.id, name: token.name, capability: token.capability };
      // Future mutations fail closed even if their route omits a capability hook.
      if (request.method !== "GET" && request.method !== "HEAD" && token.capability !== "manage") {
        return deny(reply, 403);
      }
    });
  });
}
