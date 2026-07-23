import type { FastifyInstance } from "fastify";

import { setupHttpValidation } from "../lib/http/validation.js";
import { setupAuth } from "./auth.js";
import { setupCors } from "./cors.js";
import { setupDatabase } from "./database.js";
import { setupObservability } from "./observability.js";
import { setupSecurity } from "./security.js";

export function setupCorePlugins(app: FastifyInstance): void {
  setupHttpValidation(app);
  setupObservability(app);
  setupSecurity(app);
  setupCors(app);
  setupAuth(app);
  // Registered unconditionally: it is cheap (a single SQLite connection) and
  // independent of Clerk configuration, unlike setupAuth().
  setupDatabase(app);
}
