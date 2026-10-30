import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from "fastify";

import type { DeployRuntimeConfig } from "./config.js";
import type { DokployClient } from "./dokploy/client.js";
import { createNotFoundErrorEnvelope, normalizeDeployError } from "./lib/http/errors.js";
import { buildLoggerOptions, type DeployLoggerStream } from "./lib/http/logging.js";
import { registerModules } from "./modules/index.js";
import { createContainerObserver, type ContainerObserver } from "./observe/observer.js";
import { setupCorePlugins } from "./plugins/index.js";
import { DEPLOY_DESIRED_STATE } from "./reconcile/desired-state.gen.js";

declare module "fastify" {
  interface FastifyInstance {
    runtimeConfig: DeployRuntimeConfig;
    dokploy: DokployClient;
    containerObserver: ContainerObserver;
  }
}

export interface BuildDeployAppOptions {
  /** The typed Dokploy API client, decorated onto the instance as `app.dokploy`. */
  dokploy: DokployClient;
  /** Where log records go instead of stdout, so tests can assert on redaction. */
  loggerStream?: DeployLoggerStream;
}

/**
 * 64 KiB, same ceiling as `apps/secrets` — `/health` is the only route today, so this bounds the
 * largest legitimate body a later route could take rather than anything this scaffold parses.
 */
const REQUEST_BODY_LIMIT_BYTES = 65_536;

export function buildApp(
  config: DeployRuntimeConfig,
  options: BuildDeployAppOptions,
): FastifyInstance {
  const loggerOptions =
    options.loggerStream === undefined
      ? buildLoggerOptions(config)
      : buildLoggerOptions(config, { stream: options.loggerStream });

  const appOptions = {
    bodyLimit: REQUEST_BODY_LIMIT_BYTES,
    forceCloseConnections: true,
    logController: new LogController({ disableRequestLogging: true }),
    logger: loggerOptions,
    // No `trustProxy`, no `https`: nothing fronts this service and it serves no TLS of its own.
  } satisfies FastifyServerOptions;

  const app: FastifyInstance = Fastify(appOptions);

  app.decorate("runtimeConfig", config);
  app.decorate("dokploy", options.dokploy);
  app.decorate("containerObserver", createContainerObserver(options.dokploy, DEPLOY_DESIRED_STATE));
  setupCorePlugins(app);

  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeDeployError(error);

    if (normalized.logLevel === "error") {
      request.log.error({ err: error }, "request failed");
    } else {
      request.log[normalized.logLevel](
        { error: normalized.envelope.error },
        "request completed with client error",
      );
    }

    reply.status(normalized.statusCode).send(normalized.envelope);
  });

  app.setNotFoundHandler((request, reply) => {
    const envelope = createNotFoundErrorEnvelope();

    request.log.info({ error: envelope.error }, "route not found");
    reply.status(404).send(envelope);
  });

  app.register(registerModules);

  return app;
}
