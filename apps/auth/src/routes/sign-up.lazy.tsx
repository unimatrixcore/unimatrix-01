import { createLazyFileRoute, getRouteApi } from "@tanstack/react-router";

import { SignUp } from "@unimatrix/auth/react";

import { safeRedirectUrl, withRedirectParam } from "@/features/auth/safe-redirect";

const routeApi = getRouteApi("/sign-up");

export const Route = createLazyFileRoute("/sign-up")({
  component: SignUpRoute,
});

function SignUpRoute() {
  const { redirect_url } = routeApi.useSearch();
  // Validated against the same-family allowlist before use (see sign-in.lazy.tsx).
  const target = safeRedirectUrl(redirect_url);

  return (
    /* See the comment in sign-in.lazy.tsx for why this uses routing="hash". */
    <SignUp
      forceRedirectUrl={target}
      routing="hash"
      signInUrl={withRedirectParam("/sign-in", redirect_url)}
    />
  );
}
