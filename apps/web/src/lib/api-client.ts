import { useMemo } from "react";
import { createApiClient, type ApiClient } from "@unimatrix/api-client";
import { useAuth } from "@unimatrix/auth/react";

import { isAuthEnabled, loadWebRuntimeConfig } from "./config.js";

const runtimeConfig = loadWebRuntimeConfig({
  VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
  VITE_AUTH_APP_URL: import.meta.env.VITE_AUTH_APP_URL,
  VITE_CLERK_PUBLISHABLE_KEY: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
});

/**
 * Tokenless API client for public, unauthenticated calls (for example
 * `GET /health`). Always available regardless of whether Clerk is
 * configured, so public-site data fetching never depends on auth being
 * enabled.
 */
export const apiClient: ApiClient = createApiClient({
  baseUrl: runtimeConfig.apiBaseUrl,
});

function useTokenlessApiClient(): ApiClient {
  return apiClient;
}

/**
 * Builds an `ApiClient` wired to send the current Clerk session token as
 * the Bearer token. Calls `getToken()` with **no `template` argument** —
 * the plain session token already carries the `permissions` claim via
 * session-token customization (see `@unimatrix/auth`'s README) — mirroring
 * `apps/auth`'s `useApiClient()`.
 *
 * Only ever selected as `useApiClient` (below) when auth is enabled, in
 * which case `AuthBoundary` guarantees an `AuthProvider` is mounted above
 * every consumer, so this `useAuth()` call is always valid.
 */
function useAuthedApiClient(): ApiClient {
  const { getToken } = useAuth();

  return useMemo(
    () =>
      createApiClient({
        baseUrl: runtimeConfig.apiBaseUrl,
        getAuthToken: () => getToken(),
      }),
    [getToken],
  );
}

/**
 * The one supported way to obtain an `ApiClient` for component/route code.
 * Resolved once, at module scope, from static build-time config rather than
 * branched inside a component body — so which underlying hook is called
 * never changes across renders and rules-of-hooks stays satisfied whether
 * or not auth is enabled:
 * - Auth disabled (no `VITE_CLERK_PUBLISHABLE_KEY`): resolves to
 *   {@link useTokenlessApiClient}, which calls no Clerk hooks at all.
 * - Auth enabled: resolves to {@link useAuthedApiClient}, which reads the
 *   current Clerk session token via `useAuth()` on every call.
 */
export const useApiClient: () => ApiClient = isAuthEnabled(runtimeConfig)
  ? useAuthedApiClient
  : useTokenlessApiClient;
