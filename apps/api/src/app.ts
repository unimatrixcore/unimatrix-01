import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import type { ApiRuntimeConfig } from "./config.js";
import {
  createNotFoundErrorEnvelope,
  normalizeError,
} from "./lib/http/errors.js";
import { buildLoggerOptions } from "./lib/http/logging.js";
import { registerModules } from "./modules/index.js";
import { registerCorePlugins } from "./plugins/index.js";

declare module "fastify" {
  interface FastifyInstance {
    runtimeConfig: ApiRuntimeConfig;
  }
}

export function buildApp(config: ApiRuntimeConfig): FastifyInstance {
  const appOptions = {
    forceCloseConnections: true,
    logger: buildLoggerOptions(config),
  } satisfies FastifyServerOptions;

  const app: FastifyInstance = Fastify(appOptions);

  app.decorate("runtimeConfig", config);
  void registerCorePlugins(app, {});

  app.setErrorHandler((error, request, reply) => {
    const requestId = String(request.id);
    const normalizedError = normalizeError(error, requestId);

    if (normalizedError.logLevel === "error") {
      app.log.error(
        { err: error, method: request.method, requestId, url: request.url },
        "request failed",
      );
    } else {
      app.log[normalizedError.logLevel](
        {
          error: normalizedError.envelope.error,
          method: request.method,
          requestId,
          url: request.url,
        },
        "request failed",
      );
    }

    reply.status(normalizedError.statusCode).send(normalizedError.envelope);
  });

  app.setNotFoundHandler((request, reply) => {
    const requestId = String(request.id);
    const envelope = createNotFoundErrorEnvelope(requestId);

    app.log.info(
      { method: request.method, requestId, url: request.url },
      "route not found",
    );

    reply.status(404).send(envelope);
  });

  app.register(registerModules);

  return app;
}
