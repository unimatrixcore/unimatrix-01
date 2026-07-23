import { createLazyFileRoute, getRouteApi } from "@tanstack/react-router";

import { SignIn } from "@unimatrix/auth/react";

import { safeRedirectUrl, withRedirectParam } from "@/features/auth/safe-redirect";

const routeApi = getRouteApi("/sign-in");

export const Route = createLazyFileRoute("/sign-in")({
  component: SignInRoute,
});

function SignInRoute() {
  const { redirect_url } = routeApi.useSearch();
  // Validated against the same-family allowlist before it can ever be used
  // as a post-auth redirect target; falls back to the auth landing ("/").
  const target = safeRedirectUrl(redirect_url);

  return (
    <>
      {/*
       * Clerk's <SignIn /> needs to route its own internal sub-steps
       * (email code entry, MFA, etc). Two options integrate with
       * TanStack Router: `routing="path"` + a splat child route
       * (`/sign-in/$`), or `routing="hash"`, which keeps every sub-step
       * on this same `/sign-in` route and manages state via the URL
       * hash instead. We use `routing="hash"` here — it avoids adding a
       * splat route just for Clerk's internal navigation, and this app
       * has no other routes nested under `/sign-in` that would need to
       * coexist with a path-based splat.
       *
       * `forceRedirectUrl={target}` sends the user back to the service
       * that linked here after a successful sign-in; `signUpUrl` carries
       * the same (unvalidated) redirect_url so switching to sign-up keeps
       * the destination.
       */}
      <SignIn
        forceRedirectUrl={target}
        routing="hash"
        signUpUrl={withRedirectParam("/sign-up", redirect_url)}
      />
    </>
  );
}
