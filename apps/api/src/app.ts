import type { DatabaseInstance } from "@unimatrix/db";
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
    db: DatabaseInstance["db"];
  }
}

export function buildApp(config: ApiRuntimeConfig): FastifyInstance {
  const appOptions = {
    disableRequestLogging: true,
    forceCloseConnections: true,
    logger: buildLoggerOptions(config),
    trustProxy: config.trustProxy,
  } satisfies FastifyServerOptions;

  const app: FastifyInstance = Fastify(appOptions);

  app.decorate("runtimeConfig", config);
  setupCorePlugins(app);

  app.setErrorHandler((error, request, reply) => {
    const requestId = String(request.id);
    const normalizedError = normalizeError(error, requestId);

    if (normalizedError.logLevel === "error") {
      if (isResponseSerializationError(error)) {
        request.responseLogContext = {
          err: error,
          responseSchemaMethod: error.method,
          responseSchemaUrl: error.url,
          responseValidationIssues: error.cause.issues,
        };
      } else {
        request.responseLogContext = {
          err: error,
        };
      }
    } else {
      request.responseLogContext = {
        error: normalizedError.envelope.error,
      };
    }

    request.responseLogMessage =
      normalizedError.logLevel === "error" ? "request failed" : "request completed with client error";

    reply.status(normalizedError.statusCode).send(normalizedError.envelope);
  });

  app.setNotFoundHandler((request, reply) => {
    const requestId = String(request.id);
    const envelope = createNotFoundErrorEnvelope(requestId);

    request.responseLogContext = {
      error: envelope.error,
    };
    request.responseLogMessage = "route not found";

    reply.status(404).send(envelope);
  });

  app.register(registerModules);

  return app;
}
