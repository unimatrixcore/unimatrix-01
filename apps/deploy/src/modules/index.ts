import type { FastifyPluginAsync } from "fastify";

import { healthModule } from "./health/index.js";
import { deploymentModule } from "./deployment/index.js";
import { deploymentAttemptsModule } from "./deployment/attempts.js";
import { deploymentRedeployModule } from "./deployment/redeploy.js";

export const registerModules: FastifyPluginAsync = (app) => {
  app.register(healthModule);
  app.register(deploymentModule);
  app.register(deploymentAttemptsModule);
  app.register(deploymentRedeployModule);

  return Promise.resolve();
};
