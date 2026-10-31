import type { FastifyPluginAsync } from "fastify";

import { healthModule } from "./health/index.js";
import { deploymentModule } from "./deployment/index.js";
import { deploymentAttemptsModule } from "./deployment/attempts.js";

export const registerModules: FastifyPluginAsync = (app) => {
  app.register(healthModule);
  app.register(deploymentModule);
  app.register(deploymentAttemptsModule);

  return Promise.resolve();
};
