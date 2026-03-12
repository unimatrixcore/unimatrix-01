import type { FastifyPluginAsync } from "fastify";

import { setupHttpValidation } from "../lib/http/validation.js";

export const registerCorePlugins: FastifyPluginAsync = (app) => {
  setupHttpValidation(app);

  return Promise.resolve();
};
