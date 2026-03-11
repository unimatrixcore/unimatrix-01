import { buildApp } from "./app.js";
import { loadApiRuntimeConfig } from "./config.js";

const config = loadApiRuntimeConfig();
const app = buildApp(config);

let isShuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  app.log.info({ signal }, "shutting down api server");

  try {
    await app.close();
    process.exitCode = 0;
    process.exit();
  } catch (error) {
    process.exitCode = 1;
    app.log.error({ err: error, signal }, "failed to shut down api server");
    process.exit();
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
      await app.close();
    } catch (closeError) {
      app.log.error({ err: closeError }, "failed to close api server after startup error");
    } finally {
      process.exit();
    }
  }
}

await startServer();
