import type { FastifyInstance } from "fastify";

import { setupHttpValidation } from "../lib/http/validation.js";

export function setupCorePlugins(app: FastifyInstance): void {
  setupHttpValidation(app);
}
