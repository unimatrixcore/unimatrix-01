import { Outlet, createLazyFileRoute } from "@tanstack/react-router";
import { canAccessAdminSection } from "@unimatrix/auth";
import { usePermissions } from "@unimatrix/auth/react";
import { Toaster } from "@unimatrix/ui";

import { SectionAccessDenied } from "@/features/sections/section-panel";

export const Route = createLazyFileRoute("/content")({
  component: ContentRoute,
});

/**
 * One of two gated sections today, alongside `/secrets`.
 * `usePermissions().permissions` is `UserPermissionsMetadata["permissions"]`,
 * so wrapping it in `{ permissions }` satisfies `canAccessAdminSection`'s
 * first parameter directly.
 *
 * `<Toaster />` is mounted here rather than in `AppShell`: publish, delete and
 * upload are the only actions in this section that report errors through a
 * toast, and this is the only route that reaches `@unimatrix/ui`'s root
 * barrel.
 */
function ContentRoute() {
  const { isLoaded, permissions } = usePermissions();
  const { runtimeConfig } = Route.useRouteContext();

  if (!isLoaded) {
    return null;
  }

  return (
    <>
      {canAccessAdminSection({ permissions }, "content") ? (
        <Outlet />
      ) : (
        <SectionAccessDenied
          authAppUrl={runtimeConfig.authAppUrl}
          description="This tool manages the site’s blog posts and projects."
        />
      )}
      <div className="absolute">
        <Toaster position="bottom-right" />
      </div>
    </>
  );
}
