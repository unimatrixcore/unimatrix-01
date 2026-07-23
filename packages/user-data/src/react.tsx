import { useAuth } from "@unimatrix/auth/react";
import * as React from "react";

import { createUserStore } from "./create-user-store.js";
import type { ConflictPolicy } from "./migration.js";
import { migrateGuestDataToAccount } from "./migration.js";
import type { UserStore } from "./types.js";

const DEFAULT_BASE_URL = "/api";

export type UseUserStoreMode = "account" | "guest" | "unauthenticated";

export interface UseUserStoreOptions {
  /** Whether a signed-out visitor gets a guest (IndexedDB) store. Defaults to `true`. */
  allowGuest?: boolean;
  /** API base URL passed to the account adapter. Defaults to `"/api"`. */
  baseUrl?: string;
}

export interface UseUserStoreResult {
  mode: UseUserStoreMode;
  store: UserStore | null;
  /** `false` while Clerk is still resolving auth state — `store` is `null` until then. */
  isReady: boolean;
}

/**
 * Resolves the right `UserStore` for `namespace` given the current auth
 * state: signed in -> account store; signed out with `allowGuest` (the
 * default) -> guest store; signed out with `allowGuest: false` ->
 * `{ mode: "unauthenticated", store: null }` so the caller can prompt
 * sign-in instead. Requires an `AuthProvider` (from `@unimatrix/auth/react`)
 * above it in the tree — it calls `useAuth()` unconditionally, so mounting
 * it outside a provider throws Clerk's own "must be used within
 * ClerkProvider" error, not a silent fallback.
 */
export function useUserStore(namespace: string, options?: UseUserStoreOptions): UseUserStoreResult {
  const allowGuest = options?.allowGuest ?? true;
  const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;

  // Called unconditionally, per rules-of-hooks; branching happens below on
  // its return value instead of on whether to call it at all.
  const { getToken, isLoaded, isSignedIn } = useAuth();

  return React.useMemo<UseUserStoreResult>(() => {
    if (!isLoaded) {
      return { mode: "unauthenticated", store: null, isReady: false };
    }

    if (isSignedIn) {
      const store = createUserStore({
        mode: "account",
        namespace,
        baseUrl,
        getToken: () => getToken(),
      });
      return { mode: "account", store, isReady: true };
    }

    if (allowGuest) {
      const store = createUserStore({ mode: "guest", namespace });
      return { mode: "guest", store, isReady: true };
    }

    return { mode: "unauthenticated", store: null, isReady: true };
  }, [allowGuest, baseUrl, getToken, isLoaded, isSignedIn, namespace]);
}

export interface UseGuestDataMigrationOptions {
  /** API base URL passed to the account adapter used for the migration. Defaults to `"/api"`. */
  baseUrl?: string;
  conflictPolicy?: ConflictPolicy;
  clearGuestAfter?: boolean;
}

/**
 * Opt-in migration hook: a service calls this deliberately (it is never
 * invoked implicitly by `useUserStore`). The first time this component
 * observes the user transition from signed-out to signed-in — not on
 * initial mount if already signed in — it runs
 * `migrateGuestDataToAccount` exactly once for `namespace` and never
 * again for the lifetime of the component. Requires an `AuthProvider`
 * above it, same as `useUserStore`.
 */
export function useGuestDataMigration(namespace: string, options?: UseGuestDataMigrationOptions): void {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const wasSignedOutRef = React.useRef(false);
  const hasMigratedRef = React.useRef(false);
  const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;
  const conflictPolicy = options?.conflictPolicy;
  const clearGuestAfter = options?.clearGuestAfter;

  React.useEffect(() => {
    if (!isLoaded) {
      return;
    }

    if (!isSignedIn) {
      wasSignedOutRef.current = true;
      return;
    }

    if (!wasSignedOutRef.current || hasMigratedRef.current) {
      return;
    }

    hasMigratedRef.current = true;

    const account = createUserStore({
      mode: "account",
      namespace,
      baseUrl,
      getToken: () => getToken(),
    });
    const guest = createUserStore({ mode: "guest", namespace });

    migrateGuestDataToAccount({
      namespace,
      account,
      guest,
      options: {
        ...(conflictPolicy !== undefined ? { conflictPolicy } : {}),
        ...(clearGuestAfter !== undefined ? { clearGuestAfter } : {}),
      },
    }).catch((error: unknown) => {
      // The ref was latched to `true` above to prevent a concurrent second
      // run while this one is in flight. On failure, un-latch so a later
      // effect run can retry, and surface the error instead of swallowing
      // it (the promise was previously fire-and-forget).
      hasMigratedRef.current = false;
      console.error("[user-data] guest-to-account migration failed", error);
    });
  }, [baseUrl, clearGuestAfter, conflictPolicy, getToken, isLoaded, isSignedIn, namespace]);
}
