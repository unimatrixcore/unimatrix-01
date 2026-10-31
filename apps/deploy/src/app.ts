import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { ServerOptions as HttpsServerOptions } from "node:https";

import type { DeployRuntimeConfig } from "./config.js";
import type { DokployClient } from "./dokploy/client.js";
import { createNotFoundErrorEnvelope, normalizeDeployError } from "./lib/http/errors.js";
import { buildLoggerOptions, type DeployLoggerStream } from "./lib/http/logging.js";
import { registerModules } from "./modules/index.js";
import { createContainerObserver, type ContainerObserver } from "./observe/observer.js";
import { setupCorePlugins } from "./plugins/index.js";
import { setupServiceTokenAuth } from "./plugins/auth.js";
import { DEPLOY_DESIRED_STATE } from "./reconcile/desired-state.gen.js";
import { openServiceTokenStore, type ServiceTokenStore } from "./service-tokens/store.js";
import { setupDeploymentAttempts, type RuntimeEvidenceReader } from "./attempts/lifecycle.js";
import type { DeploymentAttemptStore } from "./attempts/store.js";

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
  https?: HttpsServerOptions;
  /** Owned and closed by the app, including when supplied by a test. */
  serviceTokens?: ServiceTokenStore;
  deploymentAttempts?: DeploymentAttemptStore;
  readRuntimeEvidence?: RuntimeEvidenceReader;
}

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
    ...(options.https === undefined ? {} : { https: options.https }),
  } satisfies FastifyServerOptions;

  const app: FastifyInstance = Fastify(appOptions);

  app.decorate("runtimeConfig", config);
  app.decorate("dokploy", options.dokploy);
  app.decorate(
    "containerObserver",
    createContainerObserver(options.dokploy, DEPLOY_DESIRED_STATE, Date.now, () => {
      app.log.warn("container observation poll failed");
    }),
  );
  setupCorePlugins(app);
  const serviceTokens = options.serviceTokens ?? openServiceTokenStore(config.databasePath);
  app.addHook("onClose", () => {
    serviceTokens.close();
    return Promise.resolve();
  });
  setupServiceTokenAuth(app, serviceTokens);
  setupDeploymentAttempts(
    app,
    config.databasePath,
    options.deploymentAttempts,
    options.readRuntimeEvidence,
  );

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
