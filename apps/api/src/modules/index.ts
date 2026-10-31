import type { FastifyPluginAsync } from "fastify";

import { contentModule } from "./content/index.js";
import { publicDeploymentModule, type PublicDeploymentModuleOptions } from "./deployment/index.js";
import { healthModule } from "./health/index.js";
import { integrationsModule } from "./integrations/index.js";
import { secretsAdminModule } from "./secrets/index.js";
import { userDataModule } from "./user-data/index.js";

export const registerModules: FastifyPluginAsync<PublicDeploymentModuleOptions> = (
  app,
  options,
) => {
  app.register(publicDeploymentModule, options);
  app.register(healthModule);

  // Registered unconditionally: its public read routes back the public site's
  // blog and project pages, which must render whether or not Clerk is
  // configured. The module registers its own admin routes internally only
  // when Clerk is present.
  app.register(contentModule);

  // Only registered when Clerk is configured: requireAuth()/requirePermission()
  // need registerClerkAuth() to have run, and there is no auth surface to
  // expose in local dev without Clerk keys.
  if (app.runtimeConfig.clerk !== null) {
    app.register(userDataModule);
  }

  // Needs both: requireAdminSection() needs registerClerkAuth() to have run
  // (same reason as userDataModule above), and a refresh route with no
  // configured secrets store is better absent than 500ing on every call.
  if (app.runtimeConfig.clerk !== null && app.runtimeConfig.secretsStore !== null) {
    app.register(integrationsModule);
  }

  // Needs Clerk (same reason as integrationsModule above) plus both scoped
  // tokens, not just a configured store: `setupSecretsManagement` only
  // decorates `app.secretsManagement` when it can build a client for each
  // tier, and a console that can reach one tier would render the other as
  // "not set" rather than "not reachable".
  if (
    app.runtimeConfig.clerk !== null &&
    app.runtimeConfig.secretsStore !== null &&
    app.runtimeConfig.secretsStore.integrationsManageToken !== null &&
    app.runtimeConfig.secretsStore.platformWriteToken !== null
  ) {
    app.register(secretsAdminModule);
  }

  return Promise.resolve();
};
