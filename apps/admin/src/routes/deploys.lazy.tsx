import { createLazyFileRoute } from "@tanstack/react-router";
import { canAccessAdminSection } from "@unimatrix/auth";
import { usePermissions } from "@unimatrix/auth/react";
import { Toaster } from "@unimatrix/ui/editor";

import { DeploysPage } from "@/features/deploys/deploys-page";
import { SectionAccessDenied } from "@/features/sections/section-panel";

export const Route = createLazyFileRoute("/deploys")({
  component: DeploysRoute,
});

function DeploysRoute() {
  const { isLoaded, permissions } = usePermissions();
  const { runtimeConfig } = Route.useRouteContext();

  if (!isLoaded) {
    return null;
  }

  return (
    <>
      {canAccessAdminSection({ permissions }, "deploys") ? (
        <DeploysPage />
      ) : (
        <SectionAccessDenied
          authAppUrl={runtimeConfig.authAppUrl}
          description="This tool inspects and operates deployments."
        />
      )}
      <div className="absolute">
        <Toaster position="bottom-right" />
      </div>
    </>
  );
}
