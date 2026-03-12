import type { FastifyPluginAsync } from "fastify";

import { healthModule } from "./health/index.js";

export const registerModules: FastifyPluginAsync = (app) => {
  app.register(healthModule);

  return Promise.resolve();
};
