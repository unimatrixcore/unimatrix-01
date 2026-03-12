import Fastify, { type FastifyInstance } from "fastify";

import type { ApiRuntimeConfig } from "./config.js";
import { registerModules } from "./modules/index.js";
import { registerCorePlugins } from "./plugins/index.js";

declare module "fastify" {
  interface FastifyInstance {
    runtimeConfig: ApiRuntimeConfig;
  }
}

export function buildApp(config: ApiRuntimeConfig): FastifyInstance {
  const app = Fastify({
    forceCloseConnections: true,
    logger: true,
  });

  app.decorate("runtimeConfig", config);
  app.register(async (instance) => {
    await registerCorePlugins(instance);
    await registerModules(instance);
  });

  return app;
}
