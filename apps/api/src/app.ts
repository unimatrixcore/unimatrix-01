import type { DeployClient } from "@unimatrix/deploy-client";
import type { DatabaseInstance } from "@unimatrix/db";
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from "fastify";
import { isResponseSerializationError } from "fastify-type-provider-zod";

import type { ApiRuntimeConfig } from "./config.js";
import { createNotFoundErrorEnvelope, normalizeError } from "./lib/http/errors.js";
import { buildLoggerOptions, type ApiLoggerStream } from "./lib/http/logging.js";
import { registerModules } from "./modules/index.js";
import { setupCorePlugins } from "./plugins/index.js";

declare module "fastify" {
  interface FastifyInstance {
    runtimeConfig: ApiRuntimeConfig;
    db: DatabaseInstance["db"];
  }
}

export interface BuildApiAppOptions {
  deployClient?: DeployClient;
  /** Where log records go instead of stdout, so tests can assert on redaction. */
  loggerStream?: ApiLoggerStream;
  /** Test seam: the `fetch` the integration-credentials plugin uses instead of the global. */
  secretsFetch?: typeof globalThis.fetch;
  /** Test seam: the integration names to fetch instead of the registry's. */
  integrationNames?: readonly string[];
}

export function buildAppOptions(
  config: ApiRuntimeConfig,
  options: Pick<BuildApiAppOptions, "loggerStream"> = {},
) {
  return {
    forceCloseConnections: true,
    // Fastify's own per-request lines are redundant here: the `onResponse` hook in
    // `src/plugins/observability.ts` emits the app's `request completed` record.
    logController: new LogController({ disableRequestLogging: true }),
    logger:
      options.loggerStream === undefined
        ? buildLoggerOptions(config)
        : buildLoggerOptions(config, { stream: options.loggerStream }),
    trustProxy: config.trustProxy,
  } satisfies FastifyServerOptions;
}

export function buildApp(
  config: ApiRuntimeConfig,
  options: BuildApiAppOptions = {},
): FastifyInstance {
  const app: FastifyInstance = Fastify(
    buildAppOptions(
      config,
      options.loggerStream === undefined ? {} : { loggerStream: options.loggerStream },
    ),
  );

  app.decorate("runtimeConfig", config);
  setupCorePlugins(app, {
    ...(options.secretsFetch === undefined ? {} : { secretsFetch: options.secretsFetch }),
    ...(options.integrationNames === undefined
      ? {}
      : { integrationNames: options.integrationNames }),
  });

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
      normalizedError.logLevel === "error"
        ? "request failed"
        : "request completed with client error";

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

  app.register(
    registerModules,
    options.deployClient === undefined ? {} : { deployClient: options.deployClient },
  );

  return app;
}
