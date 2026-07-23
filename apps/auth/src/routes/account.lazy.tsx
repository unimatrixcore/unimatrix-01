import { createLazyFileRoute } from "@tanstack/react-router";

import { RedirectToSignIn, SignedIn, SignedOut, UserProfile } from "@unimatrix/auth/react";

export const Route = createLazyFileRoute("/account")({
  component: AccountRoute,
});

function AccountRoute() {
  return (
    <div className="flex justify-center">
      <SignedIn>
        {/* See the comment in sign-in.lazy.tsx for why this uses routing="hash". */}
        <UserProfile routing="hash" />
      </SignedIn>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
    </div>
  );
}
