import { createLazyFileRoute } from "@tanstack/react-router";

import { RedirectToSignIn, SignedIn, SignedOut, usePermissions } from "@unimatrix/auth/react";
import { Card } from "@unimatrix/ui/public";

import { AdminPanel } from "@/features/admin/admin-panel";

export const Route = createLazyFileRoute("/admin")({
  component: AdminRoute,
});

function AdminRoute() {
  return (
    <>
      <SignedIn>
        <AdminGate />
      </SignedIn>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
    </>
  );
}

function AdminGate() {
  const { isAdmin, isLoaded } = usePermissions();

  if (!isLoaded) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (!isAdmin()) {
    return (
      <Card className="site-panel max-w-2xl px-6 py-8">
        <div className="space-y-3">
          <h1 className="text-2xl leading-tight font-medium tracking-[-0.05em] text-foreground">
            You don&apos;t have access
          </h1>
          <p className="max-w-xl text-sm leading-7 text-muted-foreground">
            This area is limited to platform administrators. If you believe
            you should have access, ask an existing administrator to grant
            it.
          </p>
        </div>
      </Card>
    );
  }

  return <AdminPanel />;
}
