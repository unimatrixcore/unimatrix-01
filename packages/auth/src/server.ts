import { clerkPlugin, createClerkClient, getAuth, verifyToken } from "@clerk/fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AdminSection, AppSlug, Role, SessionPermissionsClaim } from "./permissions.js";
import { canAccessAdminSection, hasPermission } from "./permissions.js";
import type { ServicePrincipal } from "./service-principal.js";

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
 * slot into `apps/api`'s error normalization
 * (`apps/api/src/lib/http/errors.ts`'s `ApiError`/`normalizeError` pattern):
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

  if (
    typeof rawPermissions !== "object" ||
    rawPermissions === null ||
    Array.isArray(rawPermissions)
  ) {
    return {};
  }

  return { permissions: rawPermissions };
}

/**
 * Returns a Fastify `preHandler` that requires an authenticated Clerk
 * session, throwing {@link AuthError} with `kind: "unauthorized"`
 * otherwise. Requires {@link registerClerkAuth} to have been registered
 * first.
 *
 * **The `async` is load-bearing — do not remove it.** Fastify's hook runner
 * advances the chain in exactly two ways: the hook calls the `next` callback
 * it is passed as a third argument, or it returns a thenable that Fastify
 * subscribes to (`lib/hooks.js`, `hookRunnerGenerator`). A *synchronous* hook
 * that takes only `request` therefore never advances anything: a thrown error
 * is caught and turned into a response, but a successful return value of
 * `undefined` leaves the request parked in the preHandler phase forever, with
 * the event loop free and nothing logged. The failure mode is inverted from
 * the usual one — rejected requests answer normally and *authorized* ones hang
 * — so it survives any test that only asserts 401/403.
 */
export function requireAuth() {
  // The rule is right in general and wrong here: the `async` is not sugar for
  // an awaited call, it is how Fastify is told this hook returns a thenable.
  // eslint-disable-next-line @typescript-eslint/require-await -- see the note above; removing `async` parks every authorized request forever.
  return async function requireAuthPreHandler(request: FastifyRequest): Promise<void> {
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
 *
 * `async` for the same load-bearing reason as {@link requireAuth} — read the
 * note there before changing this signature.
 */
export function requirePermission(appSlug: AppSlug, role: Role) {
  const requireAuthPreHandler = requireAuth();

  return async function requirePermissionPreHandler(request: FastifyRequest): Promise<void> {
    await requireAuthPreHandler(request);

    const claim = getSessionPermissionsClaim(request);

    if (!hasPermission(claim, appSlug, role)) {
      throw new AuthError({ kind: "forbidden" });
    }
  };
}

/**
 * Returns a Fastify `preHandler` that requires an authenticated Clerk session
 * allowed to access `section` of the admin app. Throws {@link AuthError} with
 * `kind: "unauthorized"` when there is no session, or `kind: "forbidden"` when
 * the session fails the section's gate. Requires {@link registerClerkAuth} to
 * have been registered first.
 *
 * This is a thin wrapper around `canAccessAdminSection` from this package's
 * `.` entry — the decision lives there, in one place, so the HTTP guard and
 * any UI check agree by construction. New admin API modules use this instead
 * of open-coding `requirePermission("auth", "admin")`.
 *
 * `async` for the same load-bearing reason as {@link requireAuth} — read the
 * note there before changing this signature.
 */
export function requireAdminSection(section: AdminSection) {
  const requireAuthPreHandler = requireAuth();

  return async function requireAdminSectionPreHandler(request: FastifyRequest): Promise<void> {
    await requireAuthPreHandler(request);

    const claim = getSessionPermissionsClaim(request);

    if (!canAccessAdminSection(claim, section)) {
      throw new AuthError({ kind: "forbidden" });
    }
  };
}

export interface ServiceCallerPolicy {
  ownerUserId: string;
  resource: string;
  /** Exact provider scopes this service recognizes as capabilities. */
  capabilities: readonly string[];
}

export interface ServiceCallerVerificationOptions extends ServiceCallerPolicy {
  secretKey: string;
  jwtKey: string;
  issuer: string;
  publishableKey: string;
}

export interface ServiceCallerVerifier {
  verifyOAuthCaller(
    token: string,
    requiredCapabilities: readonly string[],
  ): Promise<ServicePrincipal>;
  verifyApiKeyCaller(
    token: string,
    requiredCapabilities: readonly string[],
  ): Promise<ServicePrincipal>;
}

const scopeListSchema = z.array(z.string());

const serviceCredentialSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["oauth_token", "api_key"]),
  subject: z.string().min(1),
  scopes: scopeListSchema,
  revoked: z.boolean(),
  expired: z.boolean(),
  expiration: z.number().nullable(),
});

const oauthCredentialSchema = serviceCredentialSchema.extend({ clientId: z.string().min(1) });
const apiKeyCredentialSchema = serviceCredentialSchema.extend({
  claims: z.object({ resource: z.string() }),
});

/**
 * Separate from session guards. OAuth needs a signed resource audience and an
 * online revocation check; opaque OAuth tokens cannot establish that audience
 * through the installed SDK. API keys must carry a backend-issued resource claim.
 */
export function createServiceCallerVerifier(
  options: ServiceCallerVerificationOptions,
): ServiceCallerVerifier {
  const { ownerUserId, resource, issuer, secretKey, jwtKey, publishableKey } = options;
  const capabilities = [...options.capabilities];
  if (
    !/^user_\S+$/u.test(ownerUserId) ||
    !isHttpsIdentifier(resource) ||
    !isHttpsIdentifier(issuer) ||
    !secretKey.trim() ||
    !jwtKey.trim() ||
    !publishableKey.trim() ||
    capabilities.length === 0 ||
    capabilities.some((scope) => !scope || /\s/u.test(scope))
  ) {
    throw new Error("Invalid service caller verification configuration.");
  }

  const client = createClerkClient({ secretKey, jwtKey, publishableKey });

  function authorize(
    credential: {
      id: string;
      type: string;
      subject: string;
      scopes: string[];
      revoked: boolean;
      expired: boolean;
      expiration: number | null;
    },
    kind: ServicePrincipal["credentialKind"],
    required: readonly string[],
    clientId: string | null,
  ): ServicePrincipal {
    if (
      credential.type !== kind ||
      credential.revoked !== false ||
      credential.expired !== false ||
      (credential.expiration !== null &&
        (!Number.isFinite(credential.expiration) || credential.expiration <= Date.now())) ||
      (kind === "oauth_token" && (credential.expiration === null || !clientId))
    ) {
      throw new AuthError({ kind: "unauthorized" });
    }
    if (credential.subject !== ownerUserId) {
      throw new AuthError({ kind: "forbidden" });
    }
    const granted = capabilities.filter((scope) => credential.scopes.includes(scope));
    if (required.length === 0 || required.some((scope) => !granted.includes(scope))) {
      throw new AuthError({ kind: "forbidden" });
    }
    return Object.freeze({
      credentialKind: kind,
      userId: credential.subject,
      credentialId: credential.id,
      clientId,
      resource,
      capabilities: Object.freeze(granted),
    });
  }

  async function verifyOAuthCaller(
    token: string,
    required: readonly string[],
  ): Promise<ServicePrincipal> {
    try {
      const claims = await verifyToken(token, {
        jwtKey,
        audience: resource,
        headerType: ["at+jwt", "application/at+jwt"],
        clockSkewInMs: 0,
      });
      if (
        claims.iss !== issuer ||
        !(
          claims.aud === resource ||
          (Array.isArray(claims.aud) && claims.aud.includes(resource))
        ) ||
        !Number.isFinite(claims.exp) ||
        claims.exp * 1000 <= Date.now()
      ) {
        throw new AuthError({ kind: "unauthorized" });
      }
      const credential = oauthCredentialSchema.parse(
        await client.idPOAuthAccessToken.verify(token),
      );
      if (
        credential.subject !== claims.sub ||
        credential.id !== claims.jti ||
        credential.clientId !== claims.client_id
      ) {
        throw new AuthError({ kind: "unauthorized" });
      }
      // Capabilities must be present in both signed consent and current provider state.
      const signedScopes =
        claims.scp !== undefined
          ? isScopeList(claims.scp)
            ? claims.scp
            : []
          : typeof claims.scope === "string"
            ? claims.scope.split(" ")
            : [];
      return authorize(
        {
          ...credential,
          scopes: credential.scopes.filter((scope) => signedScopes.includes(scope)),
        },
        "oauth_token",
        required,
        credential.clientId,
      );
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError({ kind: "unauthorized" });
    }
  }

  async function verifyApiKeyCaller(
    token: string,
    required: readonly string[],
  ): Promise<ServicePrincipal> {
    try {
      if (!token.startsWith("ak_")) throw new AuthError({ kind: "unauthorized" });
      const credential = apiKeyCredentialSchema.parse(await client.apiKeys.verify(token));
      if (credential.claims?.resource !== resource) {
        throw new AuthError({ kind: "unauthorized" });
      }
      return authorize(credential, "api_key", required, null);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError({ kind: "unauthorized" });
    }
  }

  return { verifyOAuthCaller, verifyApiKeyCaller };
}

function isHttpsIdentifier(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function isScopeList(value: unknown): value is string[] {
  return scopeListSchema.safeParse(value).success;
}
