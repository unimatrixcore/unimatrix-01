import { Link, createLazyFileRoute } from "@tanstack/react-router";
import { RiShieldUserLine } from "@remixicon/react";

import {
  RedirectToSignIn,
  SignedIn,
  SignedOut,
  UserProfile,
  usePermissions,
} from "@unimatrix/auth/react";
import { Button } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/account")({
  component: AccountRoute,
});

function AccountRoute() {
  return (
    <>
      <SignedIn>
        <AccountView />
      </SignedIn>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
    </>
  );
}

function AccountView() {
  const { isAdmin } = usePermissions();

  return (
    <div className="flex flex-col items-center gap-4">
      {/* See the comment in sign-in.lazy.tsx for why this uses routing="hash". */}
      <UserProfile routing="hash" />
      {/* The auth app has no nav, so this admin-only link is the one visible
          path to /admin for platform administrators. */}
      {isAdmin() ? (
        <Button asChild className="gap-2" size="sm" variant="outline">
          <Link to="/admin">
            <RiShieldUserLine aria-hidden="true" className="size-4" />
            Admin panel
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
