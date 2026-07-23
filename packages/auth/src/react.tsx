import type { ClerkProviderProps } from "@clerk/clerk-react";
import { ClerkProvider, useUser } from "@clerk/clerk-react";
import { dark } from "@clerk/themes";
import type * as React from "react";

import type { AppSlug, Role, UserPermissionsMetadata } from "./permissions.js";
import { hasPermission, isAdmin } from "./permissions.js";

/** Clerk appearance shape, taken from `ClerkProvider`'s `appearance` prop. */
export type ClerkAppearance = NonNullable<ClerkProviderProps["appearance"]>;

/**
 * Shared Clerk appearance that themes every Clerk widget (SignIn, SignUp,
 * UserProfile, UserButton, ...) to match unimatrix-ui: forced-dark (via the
 * `dark` base theme), zero border radius, Geist Mono, and the ShadCN color
 * tokens. Colors reference the app's CSS custom properties so they track the
 * active theme instead of being hard-coded here.
 */
export const unimatrixClerkAppearance: ClerkAppearance = {
  // Cast: @clerk/themes' `dark` types `cssLayerName` as `string | undefined`,
  // which trips `exactOptionalPropertyTypes` against the `baseTheme` slot.
  baseTheme: dark as NonNullable<ClerkAppearance["baseTheme"]>,
  variables: {
    colorPrimary: "var(--primary)",
    colorBackground: "var(--card)",
    colorText: "var(--foreground)",
    colorTextSecondary: "var(--muted-foreground)",
    colorInputBackground: "var(--background)",
    colorInputText: "var(--foreground)",
    colorNeutral: "var(--foreground)",
    borderRadius: "0rem",
    fontFamily: "var(--font-mono)",
  },
  elements: {
    card: "shadow-none",
  },
};

/**
 * Thin wrapper around `@clerk/clerk-react`'s `ClerkProvider`. Accepts the
 * same props (`publishableKey`, `signInUrl`, `signUpUrl`, etc.) and passes
 * them straight through — this package never reads env vars itself, so the
 * consuming app is responsible for sourcing `publishableKey` (typically
 * from `VITE_CLERK_PUBLISHABLE_KEY`) and any redirect URLs it wants to
 * point at `https://auth.unimatrix-01.dev`.
 *
 * Applies {@link unimatrixClerkAppearance} by default so Clerk widgets match
 * the unimatrix-ui look everywhere. A consumer can still pass its own
 * `appearance` to fully replace the shared default (Clerk's appearance types
 * are too heavy to deep-merge here without tripping the type checker).
 */
export type AuthProviderProps = ClerkProviderProps;

export function AuthProvider({ appearance, ...props }: AuthProviderProps): React.JSX.Element {
  return <ClerkProvider appearance={appearance ?? unimatrixClerkAppearance} {...props} />;
}

/** Return value of {@link usePermissions}. */
export interface UsePermissionsResult {
  /** Whether Clerk has finished loading the current user. */
  isLoaded: boolean;
  /** The normalized `permissions` map read from `user.publicMetadata`. */
  permissions: UserPermissionsMetadata["permissions"];
  /** Whether the current user holds `role` for `appSlug`. */
  hasPermission: (appSlug: AppSlug, role: Role) => boolean;
  /** Whether the current user holds the platform-wide `auth` admin role. */
  isAdmin: () => boolean;
}

function readPermissionsMetadata(publicMetadata: unknown): UserPermissionsMetadata["permissions"] {
  if (typeof publicMetadata !== "object" || publicMetadata === null) {
    return {};
  }

  const { permissions } = publicMetadata as { permissions?: unknown };

  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return {};
  }

  return permissions as UserPermissionsMetadata["permissions"];
}

/**
 * Reads the current user's permissions from Clerk `publicMetadata` (see
 * this package's README for the exact shape and where it's provisioned)
 * and exposes them alongside the shared `.` helpers.
 */
export function usePermissions(): UsePermissionsResult {
  const { isLoaded, user } = useUser();
  const permissions = readPermissionsMetadata(user?.publicMetadata);
  const metadata: UserPermissionsMetadata = { permissions };

  return {
    isLoaded,
    permissions,
    hasPermission: (appSlug, role) => hasPermission(metadata, appSlug, role),
    isAdmin: () => isAdmin(metadata),
  };
}

// Thin re-exports so consuming apps depend on @unimatrix/auth/react instead
// of importing @clerk/clerk-react directly.
export {
  RedirectToSignIn,
  SignedIn,
  SignedOut,
  SignIn,
  SignUp,
  useAuth,
  UserButton,
  UserProfile,
  useUser,
} from "@clerk/clerk-react";
export type { ClerkProviderProps } from "@clerk/clerk-react";
