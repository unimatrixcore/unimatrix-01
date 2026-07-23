import type { FastifyPluginAsync } from "fastify";

import { healthModule } from "./health/index.js";
import { userDataModule } from "./user-data/index.js";

export const registerModules: FastifyPluginAsync = (app) => {
  app.register(healthModule);

  // Only registered when Clerk is configured: requireAuth()/requirePermission()
  // need registerClerkAuth() to have run, and there is no auth surface to
  // expose in local dev without Clerk keys.
  if (app.runtimeConfig.clerk !== null) {
    app.register(userDataModule);
  }

  return Promise.resolve();
};
