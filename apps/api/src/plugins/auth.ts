import { registerClerkAuth } from "@unimatrix/auth/server";
import type { FastifyInstance } from "fastify";

/**
 * Registers Clerk auth when `app.runtimeConfig.clerk` is configured.
 * `registerClerkAuth` is async, but `app.register()` queues the plugin
 * synchronously (Fastify resolves registration at `.ready()`/`.listen()`/
 * `.inject()`), so this stays a plain synchronous setup function like its
 * sibling `setup*` helpers — the returned promise is intentionally not
 * awaited here.
 */
export function setupAuth(app: FastifyInstance): void {
  const { clerk } = app.runtimeConfig;

  if (clerk === null) {
    app.log.info(
      "Clerk auth is disabled: CLERK_SECRET_KEY/CLERK_PUBLISHABLE_KEY/CLERK_JWT_KEY are not configured.",
    );
    return;
  }

  void registerClerkAuth(app, clerk);
}
