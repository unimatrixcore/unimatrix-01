import { createLazyFileRoute } from "@tanstack/react-router";
import { canAccessAdminSection } from "@unimatrix/auth";
import { usePermissions } from "@unimatrix/auth/react";
import { Toaster } from "@unimatrix/ui/editor";

import { SecretsPage } from "@/features/secrets/secrets-page";
import { SectionAccessDenied } from "@/features/sections/section-panel";

export const Route = createLazyFileRoute("/secrets")({
  component: SecretsRoute,
});

/**
 * Gated the same way Content is, through `canAccessAdminSection` — the API
 * gates its own secrets routes on the same predicate, so the two cannot drift
 * into a console that renders controls every call behind them refuses.
 *
 * `<Toaster />` is mounted here rather than in `AppShell`: every write in this
 * section reports through a toast, and Content mounts its own for the same
 * reason.
 */
function SecretsRoute() {
  const { isLoaded, permissions } = usePermissions();
  const { runtimeConfig } = Route.useRouteContext();

  if (!isLoaded) {
    return null;
  }

  return (
    <>
      {canAccessAdminSection({ permissions }, "secrets") ? (
        <SecretsPage />
      ) : (
        <SectionAccessDenied
          authAppUrl={runtimeConfig.authAppUrl}
          description="This tool manages the credentials the system runs on."
        />
      )}
      <div className="absolute">
        <Toaster position="bottom-right" />
      </div>
    </>
  );
}
