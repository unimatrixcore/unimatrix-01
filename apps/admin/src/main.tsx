import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createInstantQueryClient } from "@unimatrix/instant-list";
import { RouterProvider } from "@tanstack/react-router";

import { AuthProvider } from "@unimatrix/auth/react";

import { createAppRouter } from "@/app/router";
import { DEV_AUTH_APP_URL, buildSignInHref, loadAdminAppRuntimeConfig } from "@/lib/config";
import "@/styles.css";

const rootElement = document.getElementById("app");

if (!rootElement) {
  throw new Error("Missing #app root element.");
}

document.documentElement.classList.add("dark");
document.documentElement.style.colorScheme = "dark";

const runtimeConfig = {
  ...loadAdminAppRuntimeConfig({
    VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
    // An explicit value always wins; the dev fallback only fills the gap the
    // production default would otherwise fill, which would bounce a dev server
    // at the live hub and strand it there with a cookie it cannot read.
    VITE_AUTH_APP_URL:
      import.meta.env.VITE_AUTH_APP_URL ?? (import.meta.env.DEV ? DEV_AUTH_APP_URL : undefined),
    VITE_CLERK_PUBLISHABLE_KEY: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
  }),
  // On everywhere, dev included: the signed-out bounce is the first thing an
  // admin surface does, so a dev server that skips it cannot exercise the
  // permission gate behind it either.
  requireSignIn: true,
};

const queryClient = createInstantQueryClient();
const router = createAppRouter({ queryClient, runtimeConfig });

// `signInUrl`/`signUpUrl` point at the auth hub rather than at a local route:
// this app hosts no Clerk widgets of its own, and `auth.unimatrix-01.dev` is
// the one place a session is established for the whole family.
//
// `afterSignOutUrl` carries a `redirect_url` back to this origin, and the bare
// hub URL is the wrong value however reasonable it looks. Signing out is the
// one exit that starts *here*, so nothing downstream can recover where you
// were: you land on the hub's own landing, sign in, and the hub has no return
// address to honour — it sends you to `/account`, which reads as the sign-in
// redirect being broken when it is only ever missing. Sign out, sign back in,
// and you are returned to the console instead.
//
// The origin rather than `window.location.href`: this is fixed when the
// provider mounts, not when the button is clicked, so a deep path here would
// be whichever route happened to load first.
ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AuthProvider
      afterSignOutUrl={buildSignInHref(runtimeConfig.authAppUrl, window.location.origin)}
      publishableKey={runtimeConfig.clerkPublishableKey}
      signInUrl={`${runtimeConfig.authAppUrl}/sign-in`}
      signUpUrl={`${runtimeConfig.authAppUrl}/sign-up`}
    >
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AuthProvider>
  </React.StrictMode>,
);
