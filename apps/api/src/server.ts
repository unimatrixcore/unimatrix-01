import { buildApp } from "./app.js";
import { loadApiRuntimeConfig } from "./config.js";

const config = loadApiRuntimeConfig();
const app = buildApp(config);

let closeAppPromise: Promise<void> | null = null;
let isShuttingDown = false;

function closeApp(): Promise<void> {
  if (closeAppPromise) {
    return closeAppPromise;
  }

  closeAppPromise = app.close();

  return closeAppPromise;
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) {
    await closeApp();

    return;
  }

  isShuttingDown = true;

  app.log.info({ signal }, "shutting down api server");

  try {
    await closeApp();
    process.exitCode = 0;
  } catch (error) {
    process.exitCode = 1;
    app.log.error({ err: error, signal }, "failed to shut down api server");
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
      { address, host: config.host, port: config.port, nodeEnv: config.nodeEnv },
      "api server listening",
    );
  } catch (error) {
    process.exitCode = 1;
    app.log.error({ err: error }, "failed to start api server");

    try {
      await closeApp();
    } catch (closeError) {
      app.log.error({ err: closeError }, "failed to close api server after startup error");
    }
  }
}

await startServer();
