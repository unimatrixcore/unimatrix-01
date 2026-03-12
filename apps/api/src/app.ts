import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { isResponseSerializationError } from "fastify-type-provider-zod";

import type { ApiRuntimeConfig } from "./config.js";
import {
  createNotFoundErrorEnvelope,
  normalizeError,
} from "./lib/http/errors.js";
import { buildLoggerOptions } from "./lib/http/logging.js";
import { registerModules } from "./modules/index.js";
import { setupCorePlugins } from "./plugins/index.js";

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
  setupCorePlugins(app);

  app.setErrorHandler((error, request, reply) => {
    const requestId = String(request.id);
    const normalizedError = normalizeError(error, requestId);

    if (normalizedError.logLevel === "error") {
      if (isResponseSerializationError(error)) {
        request.log.error(
          {
            err: error,
            method: request.method,
            responseSchemaMethod: error.method,
            responseSchemaUrl: error.url,
            responseValidationIssues: error.cause.issues,
            url: request.url,
          },
          "request failed",
        );
      } else {
        request.log.error(
          {
            err: error,
            method: request.method,
            url: request.url,
          },
          "request failed",
        );
      }
    } else if (normalizedError.logLevel === "warn") {
      request.log.warn(
        {
          error: normalizedError.envelope.error,
          method: request.method,
          url: request.url,
        },
        "request failed",
      );
    } else {
      request.log.info(
        {
          error: normalizedError.envelope.error,
          method: request.method,
          url: request.url,
        },
        normalizedError.envelope.error.code === "NOT_FOUND"
          ? "route not found"
          : "request completed with client error",
      );
    }

    reply.status(normalizedError.statusCode).send(normalizedError.envelope);
  });

  app.setNotFoundHandler((request, reply) => {
    const requestId = String(request.id);
    const envelope = createNotFoundErrorEnvelope(requestId);

    request.log.info({ method: request.method, url: request.url }, "route not found");

    reply.status(404).send(envelope);
  });

  app.register(registerModules);

  return app;
}
