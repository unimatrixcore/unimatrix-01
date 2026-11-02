import { buildApp } from "./app.js";
import { loadCanvasConfig } from "./config.js";

const config = loadCanvasConfig();
const app = buildApp(config);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch {
  process.exitCode = 1;
  app.log.error({ outcome: "startup_failed" }, "startup failed");
  await app.close();
}
