import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    requestStartedAt?: number;
  }
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

    request.log.info(
      {
        durationMs,
        method: request.method,
        requestId: String(request.id),
        route,
        statusCode: reply.statusCode,
      },
      "request completed",
    );
    done();
  });
}
