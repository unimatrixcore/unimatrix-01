import type { FastifyInstance } from "fastify";

import { setupRequestObservability } from "@unimatrix/service-http";

type ApiResponseLogContext = Record<string, unknown>;
type ApiResponseLogLevel = "info" | "warn" | "error";

declare module "fastify" {
  interface FastifyRequest {
    responseLogContext?: ApiResponseLogContext;
    responseLogMessage?: string;
  }
}

function getResponseLogLevel(statusCode: number): ApiResponseLogLevel {
  if (statusCode >= 500) {
    return "error";
  }

  if (statusCode === 404) {
    return "info";
  }

  if (statusCode >= 400) {
    return "warn";
  }

  return "info";
}

export function setupObservability(app: FastifyInstance): void {
  setupRequestObservability(app, {
    onResponse(request, reply, durationMs) {
      const route = request.routeOptions.url ?? request.url;
      const level = getResponseLogLevel(reply.statusCode);
      const logContext = {
        durationMs,
        method: request.method,
        requestId: String(request.id),
        route,
        statusCode: reply.statusCode,
        url: request.url,
        ...request.responseLogContext,
      };
      const logMessage = request.responseLogMessage ?? "request completed";

      request.log[level](logContext, logMessage);
    },
  });
}
