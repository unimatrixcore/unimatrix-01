import { clerkPlugin, getAuth } from "@clerk/fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AppSlug, Role, SessionPermissionsClaim } from "./permissions.js";
import { hasPermission } from "./permissions.js";

export type {
  CreateUserManagementClientOptions,
  ListUsersOptions,
  ListUsersResult,
  UserManagementClient,
  UserSummaryData,
} from "./admin.js";
export { createUserManagementClient, normalizePermissionsMetadata } from "./admin.js";

/**
 * The kinds of failures `requireAuth()` and `requirePermission()` can
 * raise. `"unauthorized"` means there is no authenticated Clerk session at
 * all; `"forbidden"` means there is a session, but it lacks the required
 * permission.
 */
export type AuthErrorKind = "unauthorized" | "forbidden";

/** Stable error codes paired with each {@link AuthErrorKind}. */
export type AuthErrorCode = "UNAUTHORIZED" | "FORBIDDEN";

const AUTH_ERROR_STATUS_CODES: Record<AuthErrorKind, number> = {
  unauthorized: 401,
  forbidden: 403,
};

const AUTH_ERROR_CODES: Record<AuthErrorKind, AuthErrorCode> = {
  unauthorized: "UNAUTHORIZED",
  forbidden: "FORBIDDEN",
};

const DEFAULT_AUTH_ERROR_MESSAGES: Record<AuthErrorKind, string> = {
  unauthorized: "Authentication is required to access this resource.",
  forbidden: "You do not have permission to access this resource.",
};

interface AuthErrorOptions {
  kind: AuthErrorKind;
  message?: string;
}

/**
 * Thrown by `requireAuth()` and `requirePermission()` guards. Designed to
 * slot into a later phase's `apps/api` error normalization (see
 * `apps/api/src/lib/http/errors.ts`'s `ApiError`/`normalizeError` pattern):
 * a downstream handler can catch `AuthError` and map `statusCode`/`code`
 * onto an `ApiError`-shaped envelope. This package intentionally does not
 * import from `apps/api` to avoid a circular dependency.
 */
export class AuthError extends Error {
  readonly kind: AuthErrorKind;
  readonly statusCode: number;
  readonly code: AuthErrorCode;

  constructor(options: AuthErrorOptions) {
    super(options.message ?? DEFAULT_AUTH_ERROR_MESSAGES[options.kind]);

    this.name = "AuthError";
    this.kind = options.kind;
    this.statusCode = AUTH_ERROR_STATUS_CODES[options.kind];
    this.code = AUTH_ERROR_CODES[options.kind];
  }
}

/**
 * Configuration for {@link registerClerkAuth}. The consuming app reads
 * these from its own environment (typically `CLERK_SECRET_KEY`,
 * `CLERK_PUBLISHABLE_KEY`, and `CLERK_JWT_KEY`) and passes them in — this
 * package never reads `process.env` itself. `jwtKey` enables networkless
 * session JWT verification (no round-trip to Clerk's API per request).
 */
export interface RegisterClerkAuthOptions {
  /** Clerk secret key for the backend API client. */
  secretKey: string;
  /** Clerk publishable key, used to derive the Frontend API URL. */
  publishableKey: string;
  /** Clerk JWT verification key, enabling networkless session verification. */
  jwtKey: string;
}

/**
 * Registers `@clerk/fastify`'s `clerkPlugin`, configured for networkless
 * JWT verification via `jwtKey`. Call this once during app setup, before
 * any route that uses `requireAuth()` or `requirePermission()`.
 *
 * @example
 * ```ts
 * await registerClerkAuth(app, {
 *   secretKey: env.CLERK_SECRET_KEY,
 *   publishableKey: env.CLERK_PUBLISHABLE_KEY,
 *   jwtKey: env.CLERK_JWT_KEY,
 * });
 * ```
 */
export async function registerClerkAuth(
  app: FastifyInstance,
  options: RegisterClerkAuthOptions,
): Promise<void> {
  await app.register(clerkPlugin, {
    secretKey: options.secretKey,
    publishableKey: options.publishableKey,
    jwtKey: options.jwtKey,
  });
}

/**
 * Returns the verified Clerk user id for the current request's session, or
 * `null` when there is no authenticated session. This is the ONLY sanctioned
 * way to determine "who is making this request" — callers must never trust
 * a user id supplied by client input (body/query/params). Requires
 * {@link registerClerkAuth} to have been registered first, and pairs with a
 * `requireAuth()`/`requirePermission()` preHandler that has already rejected
 * unauthenticated requests, so route handlers can treat a `null` result here
 * as an unexpected/defensive case.
 */
export function getAuthUserId(request: FastifyRequest): string | null {
  return getAuth(request).userId;
}

/**
 * Extracts the typed {@link SessionPermissionsClaim} from the current
 * request's verified Clerk session claims. Returns an empty claim
 * (`{}`, which `hasPermission`/`isAdmin` treat as "no permissions") when
 * there is no authenticated session or the claim is malformed.
 *
 * Requires {@link registerClerkAuth} to have been registered first.
 */
export function getSessionPermissionsClaim(request: FastifyRequest): SessionPermissionsClaim {
  const { sessionClaims } = getAuth(request);
  const rawPermissions =
    sessionClaims === null ? undefined : (sessionClaims as { permissions?: unknown }).permissions;

  if (typeof rawPermissions !== "object" || rawPermissions === null || Array.isArray(rawPermissions)) {
    return {};
  }

  return { permissions: rawPermissions as Partial<Record<string, string[]>> };
}

/**
 * Returns a Fastify `preHandler` that requires an authenticated Clerk
 * session, throwing {@link AuthError} with `kind: "unauthorized"`
 * otherwise. Requires {@link registerClerkAuth} to have been registered
 * first.
 */
export function requireAuth() {
  return function requireAuthPreHandler(request: FastifyRequest): void {
    const { userId } = getAuth(request);

    if (userId === null) {
      throw new AuthError({ kind: "unauthorized" });
    }
  };
}

/**
 * Returns a Fastify `preHandler` that requires an authenticated Clerk
 * session holding `role` for `appSlug`. Throws {@link AuthError} with
 * `kind: "unauthorized"` when there is no session, or `kind: "forbidden"`
 * when the session lacks the required permission. Requires
 * {@link registerClerkAuth} to have been registered first.
 */
export function requirePermission(appSlug: AppSlug, role: Role) {
  const requireAuthPreHandler = requireAuth();

  return function requirePermissionPreHandler(request: FastifyRequest): void {
    requireAuthPreHandler(request);

    const claim = getSessionPermissionsClaim(request);

    if (!hasPermission(claim, appSlug, role)) {
      throw new AuthError({ kind: "forbidden" });
    }
  };
}
