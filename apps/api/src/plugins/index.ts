import type { SecretRegistryEntry } from "@unimatrix/shared";
import type { FastifyInstance } from "fastify";

import { setupHttpValidation } from "../lib/http/validation.js";
import { setupAuth } from "./auth.js";
import { setupCors } from "./cors.js";
import { setupDatabase } from "./database.js";
import { setupIntegrationCredentials } from "./integration-credentials.js";
import { setupObservability } from "./observability.js";
import { setupRateLimit } from "./rate-limit.js";
import { setupSecretsManagement } from "./secrets-management.js";
import { setupSecurity } from "./security.js";

// Add registry constants here only when an API feature consumes them.
const API_INTEGRATION_CREDENTIALS: readonly SecretRegistryEntry[] = [];

export interface SetupCorePluginsOptions {
  /**
   * A fake `fetch` for the secrets service, shared by both
   * `setupIntegrationCredentials` (a read-capability client) and
   * `setupSecretsManagement` (a manage-capability client) — one test seam
   * for both, since `registerModules` receives no options of its own
   * (`apps/api/src/app.ts`) and this is the point where a test harness can
   * still reach either plugin's construction.
   */
  secretsFetch?: typeof globalThis.fetch;
  /** Test seam — see `SetupIntegrationCredentialsOptions.names`. */
  integrationNames?: readonly string[];
}

export function setupCorePlugins(
  app: FastifyInstance,
  options: SetupCorePluginsOptions = {},
): void {
  setupHttpValidation(app);
  setupObservability(app);
  setupSecurity(app);
  // Before the routes and outside every module, so a route cannot be added
  // without a ceiling by being added somewhere this was not thought about.
  setupRateLimit(app);
  setupCors(app);
  setupAuth(app);
  // Registered unconditionally: it is cheap (a single SQLite connection) and
  // independent of Clerk configuration, unlike setupAuth().
  setupDatabase(app);
  setupIntegrationCredentials(app, {
    entries: API_INTEGRATION_CREDENTIALS,
    ...(options.secretsFetch === undefined ? {} : { fetch: options.secretsFetch }),
    ...(options.integrationNames === undefined ? {} : { names: options.integrationNames }),
  });
  setupSecretsManagement(
    app,
    options.secretsFetch === undefined ? {} : { fetch: options.secretsFetch },
  );
}
