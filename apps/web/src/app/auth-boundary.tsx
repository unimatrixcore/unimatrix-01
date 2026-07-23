import type { ReactNode } from "react";
import { AuthProvider } from "@unimatrix/auth/react";

import { isAuthEnabled, type WebRuntimeConfig } from "@/lib/config";

type AuthBoundaryProps = {
  children: ReactNode;
  config: WebRuntimeConfig;
};

/**
 * Wraps the app tree in Clerk's `AuthProvider` only when
 * `VITE_CLERK_PUBLISHABLE_KEY` is configured (see `isAuthEnabled`). When the
 * key is absent, `children` renders completely unchanged: no `ClerkProvider`
 * is mounted, no Clerk network calls happen, and the public site behaves
 * exactly as it does with auth support removed entirely. This is what makes
 * Clerk optional end-to-end for this public portfolio site.
 */
export function AuthBoundary({ children, config }: AuthBoundaryProps) {
  if (!isAuthEnabled(config)) {
    return <>{children}</>;
  }

  return (
    <AuthProvider
      afterSignOutUrl="/"
      publishableKey={config.clerkPublishableKey}
      signInUrl={`${config.authAppUrl}/sign-in`}
    >
      {children}
    </AuthProvider>
  );
}
