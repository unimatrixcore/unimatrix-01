import type { FastifyInstance } from "fastify";

import { setupHttpValidation } from "../lib/http/validation.js";
import { setupCors } from "./cors.js";
import { setupObservability } from "./observability.js";
import { setupSecurity } from "./security.js";

export function setupCorePlugins(app: FastifyInstance): void {
  setupHttpValidation(app);
  setupObservability(app);
  setupSecurity(app);
  setupCors(app);
}
