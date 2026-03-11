import Fastify, { type FastifyInstance } from "fastify";

import type { ApiRuntimeConfig } from "./config.js";
import { registerModules } from "./modules/index.js";
import { registerCorePlugins } from "./plugins/index.js";

export function buildApp(config: ApiRuntimeConfig): FastifyInstance {
  void config;

  const app = Fastify({
    forceCloseConnections: true,
    logger: true,
  });

  app.register(async (instance) => {
    await registerCorePlugins(instance);
  });
  app.register(async (instance) => {
    await registerModules(instance);
  });

  return app;
}
