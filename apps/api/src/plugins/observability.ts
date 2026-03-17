import type { FastifyInstance } from "fastify";

type ApiResponseLogContext = Record<string, unknown>;
type ApiResponseLogLevel = "info" | "warn" | "error";

declare module "fastify" {
  interface FastifyRequest {
    requestStartedAt?: number;
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
  app.addHook("onRequest", (request, _reply, done) => {
    request.requestStartedAt = Date.now();
    done();
  });

  app.addHook("onSend", (request, reply, payload, done) => {
    reply.header("x-request-id", String(request.id));
    done(null, payload);
  });

  app.addHook("onResponse", (request, reply, done) => {
    const route = request.routeOptions.url ?? request.url;
    const durationMs =
      request.requestStartedAt === undefined ? 0 : Date.now() - request.requestStartedAt;
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
    done();
  });
}
