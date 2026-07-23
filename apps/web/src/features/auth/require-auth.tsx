import type { ReactNode } from "react";
import { useEffect } from "react";
import { useAuth } from "@unimatrix/auth/react";

import { isAuthEnabled, loadWebRuntimeConfig } from "@/lib/config";

const runtimeConfig = loadWebRuntimeConfig({
  VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
  VITE_AUTH_APP_URL: import.meta.env.VITE_AUTH_APP_URL,
  VITE_CLERK_PUBLISHABLE_KEY: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
});

function buildSignInUrl(): string {
  const redirectUrl = encodeURIComponent(window.location.href);

  return `${runtimeConfig.authAppUrl}/sign-in?redirect_url=${redirectUrl}`;
}

type RequireAuthProps = {
  children: ReactNode;
};

/**
 * Reusable building block for a future protected page — NOT applied to any
 * existing route today. This whole public site is unauthenticated by
 * design, so nothing currently wraps a route in this.
 *
 * When auth is enabled and the visitor is signed out, redirects the browser
 * to `${authAppUrl}/sign-in?redirect_url=<current url>`. When signed in (or
 * when auth is disabled entirely, since there is nothing to protect against
 * without a configured Clerk key), renders `children`.
 */
export function RequireAuth({ children }: RequireAuthProps) {
  if (!isAuthEnabled(runtimeConfig)) {
    return <>{children}</>;
  }

  return <RequireAuthGate>{children}</RequireAuthGate>;
}

function RequireAuthGate({ children }: RequireAuthProps) {
  const { isLoaded, isSignedIn } = useAuth();

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      window.location.href = buildSignInUrl();
    }
  }, [isLoaded, isSignedIn]);

  if (!isLoaded || !isSignedIn) {
    return null;
  }

  return <>{children}</>;
}
