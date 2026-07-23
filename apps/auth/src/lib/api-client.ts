import { useMemo } from "react";
import { createApiClient, type ApiClient } from "@unimatrix/api-client";
import { useAuth } from "@unimatrix/auth/react";

import { loadAuthAppRuntimeConfig } from "./config.js";

const runtimeConfig = loadAuthAppRuntimeConfig({
  VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
  VITE_CLERK_PUBLISHABLE_KEY: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
});

/**
 * Builds an `ApiClient` wired to send the current Clerk session token as
 * the Bearer token. Calls `getToken()` with **no `template` argument** —
 * the plain session token already carries the `permissions` claim via
 * session-token customization (see `@unimatrix/auth`'s README), and that
 * is exactly what `apps/api` expects to verify networklessly.
 */
export function useApiClient(): ApiClient {
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
