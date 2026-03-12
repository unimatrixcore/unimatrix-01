import type { FastifyInstance } from "fastify";

import { healthModule } from "./health/index.js";

export function registerModules(app: FastifyInstance): Promise<void> {
  app.register(healthModule);

  return Promise.resolve();
}
