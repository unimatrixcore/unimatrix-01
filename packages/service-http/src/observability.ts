import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    requestStartedAt?: number;
  }
}

export interface RequestObservabilityOptions {
  onResponse?: (request: FastifyRequest, reply: FastifyReply, durationMs: number) => void;
}

export function setupRequestObservability(
  app: FastifyInstance,
  options: RequestObservabilityOptions = {},
): void {
  app.addHook("onRequest", (request, _reply, done) => {
    request.requestStartedAt = Date.now();
    done();
  });

  app.addHook("onSend", (request, reply, payload, done) => {
    reply.header("x-request-id", String(request.id));
    done(null, payload);
  });

  app.addHook("onResponse", (request, reply, done) => {
    const durationMs =
      request.requestStartedAt === undefined ? 0 : Date.now() - request.requestStartedAt;

    if (options.onResponse !== undefined) {
      options.onResponse(request, reply, durationMs);
    } else {
      const statusCode = reply.statusCode;
      const level = statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info";
      request.log[level](
        {
          durationMs,
          method: request.method,
          requestId: String(request.id),
          route: request.routeOptions.url ?? null,
          statusCode,
          outcome:
            statusCode >= 500 ? "server_error" : statusCode >= 400 ? "client_error" : "success",
        },
        "request completed",
      );
    }
    done();
  });
}
