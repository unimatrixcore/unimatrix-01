import { buildApp } from "./app.js";
import { loadDeployRuntimeConfig } from "./config.js";
import { createDokployClient, loadDokployApiKey } from "./dokploy/client.js";
import { createDokployLogClient } from "./dokploy/log-client.js";
import { createDokployRecreationClient } from "./dokploy/recreation-client.js";
import { createDokployRedeployClient } from "./dokploy/redeploy-client.js";
import { createDokployEnvClient } from "./dokploy/env-client.js";
import { createImageTagWriter } from "./secret-env/image-tag.js";
import { setupHealthMonitoring } from "./health-history/lifecycle.js";
import { resolveHealthProbeTargets } from "./health-history/probe.js";
import { DEPLOY_DESIRED_STATE } from "./reconcile/desired-state.gen.js";
import { startContainerPolling } from "./observe/polling.js";
import { loadDeployTlsOptions } from "./tls.js";

// No .env file loading here, same reasoning as apps/secrets/src/server.ts: porting it would put a
// plaintext Dokploy API key on a developer's disk. Local dev supplies DOKPLOY_BASE_URL and
// DOKPLOY_API_KEY on the command line — see README.md.
const config = loadDeployRuntimeConfig();
const dokployOptions = {
  baseUrl: config.dokployBaseUrl,
  apiKey: loadDokployApiKey(),
};
const dokploy = createDokployClient(dokployOptions);
const deploymentLogs = createDokployLogClient(dokployOptions);
const recreation = createDokployRecreationClient(dokployOptions);
const https = loadDeployTlsOptions();
const app = buildApp(config, {
  dokploy,
  deploymentLogs,
  redeployment: createDokployRedeployClient(dokployOptions),
  recreation: { inspect: (composeId) => recreation.inspect(composeId) },
  imageTags: createImageTagWriter(createDokployEnvClient(dokployOptions)),
  ...(https === undefined ? {} : { https }),
});
setupHealthMonitoring(
  app,
  config.databasePath,
  resolveHealthProbeTargets(DEPLOY_DESIRED_STATE, process.env),
);
let stopContainerPolling: (() => void) | undefined;

let closeAppPromise: Promise<void> | null = null;
let isShuttingDown = false;

function closeApp(): Promise<void> {
  if (closeAppPromise) {
    return closeAppPromise;
  }

  closeAppPromise = app.close();
  stopContainerPolling?.();

  return closeAppPromise;
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) {
    await closeApp();

    return;
  }

  isShuttingDown = true;

  app.log.info({ signal }, "shutting down deploy server");

  try {
    await closeApp();
    process.exitCode = 0;
  } catch (error) {
    process.exitCode = 1;
    app.log.error({ err: error, signal }, "failed to shut down deploy server");
  }
}

function registerSignalHandlers(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }
}

async function startServer(): Promise<void> {
  try {
    registerSignalHandlers();

    const address = await app.listen({
      host: config.host,
      port: config.port,
    });

    app.log.info(
      {
        address,
        host: config.host,
        port: config.port,
        nodeEnv: config.nodeEnv,
      },
      "deploy server listening",
    );
    stopContainerPolling = startContainerPolling(app.containerObserver, () => {
      app.log.warn("container observation poll failed");
    });
  } catch (error) {
    process.exitCode = 1;
    app.log.error({ err: error }, "failed to start deploy server");

    try {
      await closeApp();
    } catch (closeError) {
      app.log.error({ err: closeError }, "failed to close deploy server after startup error");
    }
  }
}

await startServer();
