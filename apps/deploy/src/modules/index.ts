import type { FastifyPluginAsync } from "fastify";

import { healthModule } from "./health/index.js";
import { deploymentModule } from "./deployment/index.js";

export const registerModules: FastifyPluginAsync = (app) => {
  app.register(healthModule);
  app.register(deploymentModule);

  return Promise.resolve();
};
