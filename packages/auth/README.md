# @unimatrix/auth

Shared Clerk-backed authentication and permission scheme for the Unimatrix monorepo. This package defines the single source of truth for how permissions are shaped and stored, plus thin Fastify and React integration layers on top of it.

All Unimatrix services are subdomains of `unimatrix-01.dev`. Clerk's primary domain is `unimatrix-01.dev`, sessions are shared across every subdomain automatically, and **no satellite domains are configured or needed**.

## Entry points

| Import path | Runtime | Contents |
| --- | --- | --- |
| `@unimatrix/auth` | any (zero runtime deps) | Permission types/predicates, `ServicePrincipal`, `ServiceCredentialKind`, `hasServiceCapability` |
| `@unimatrix/auth/server` | Node (Fastify 5) | Session registration/guards/accessors, `AuthError`, `createServiceCallerVerifier` |
| `@unimatrix/auth/react` | browser (React 19) | `AuthProvider`, `usePermissions`, plus re-exports of `SignIn`, `SignUp`, `UserButton`, `UserProfile`, `SignedIn`, `SignedOut`, `RedirectToSignIn`, `useAuth`, `useUser` |

Use `.` from anywhere you only need types or the pure permission-check helpers (e.g. shared validation logic). Use `./server` only in `apps/api` (or another Fastify backend). Use `./react` only in a Vite/React frontend.

## Permission scheme

Browser-session permissions are stored in Clerk `user.publicMetadata` under a single `permissions` key, mapping each app slug to the roles the user holds for that app. Service callers use explicit credential scopes instead.

```json
{
  "permissions": {
    "web": ["viewer"],
    "cflop": ["viewer", "editor"],
    "auth": ["admin"]
  }
}
```

- App slugs: `"web"`, `"cflop"`, `"auth"`, `"admin"`, `"api"` (see `AppSlug`).
- Roles: `"viewer"`, `"editor"`, `"admin"` (see `Role`).
- The platform-wide administrator role is `auth: ["admin"]` — `isAdmin(perms)` is shorthand for `hasPermission(perms, "auth", "admin")`.

### Admin sections

`ADMIN_SECTIONS` names the admin sections — `"content"` and `"secrets"` today. Every admin gate, UI and API alike, must read through one predicate rather than open-coding the check:

```ts
import { canAccessAdminSection } from "@unimatrix/auth";

canAccessAdminSection(perms, "content"); // today: equivalent to isAdmin(perms)
```

`ADMIN_SECTIONS`/`AdminSection` name the sections that exist. A private `ADMIN_SECTION_PERMISSIONS` table in `src/permissions.ts` maps each one to the `{ appSlug, role }` it requires, and today every entry is `auth:admin` — so the predicate is `isAdmin` for every section. **That table is the point.** Introducing per-section capabilities later is an edit to one record, not a change at N call sites, which only holds as long as nothing open-codes the check.

`@unimatrix/auth/server`'s `requireAdminSection(section)` is a Fastify `preHandler` wrapping the same predicate — one implementation, two surfaces. New admin API modules use it rather than `requirePermission("auth", "admin")` directly. (`apps/api/src/modules/content` still uses the latter.)

`publicMetadata` can only be written server-side — in the Clerk Dashboard or via the Clerk Backend API — never from the client. There is intentionally no public "become admin" flow.

## Session token customization

`apps/api` verifies requests networklessly by reading a custom `permissions` claim directly off the **session token** (`getAuth(req).sessionClaims`), not by calling Clerk's API per request and not via a Clerk JWT *template*. JWT templates are for minting tokens for external/third-party audiences (e.g. a separate service that only trusts its own token shape) — they are a different mechanism from the session token that Clerk issues for its own session cookies/`getToken()` calls, and `apps/api` never requests one. To make the `permissions` claim available on the session token itself, customize the session token in the Clerk Dashboard:

1. Go to **Configure → Sessions** in your Clerk instance, then **"Customize session token"**.
2. Add a top-level claim:

   ```json
   {
     "permissions": "{{user.public_metadata.permissions}}"
   }
   ```

   This copies `publicMetadata.permissions` verbatim into the session token, so its runtime shape matches `SessionPermissionsClaim`.
3. Save. Every session token Clerk issues from then on carries the claim.

On the client, call the plain `getToken()` from `useAuth()` with **no `template` argument** — that returns the (customized) session token, which is exactly what the backend expects as the Bearer token. `apps/api` verifies it networklessly via `jwtKey` (see below) and reads `getAuth(request).sessionClaims.permissions`; `@unimatrix/auth/server`'s `getSessionPermissionsClaim()` reads it from there. `@unimatrix/auth/react`'s `usePermissions()` instead reads `user.publicMetadata.permissions` directly (no token involved), which is why both places agree on the same `permissions` shape.

`SessionPermissionsClaim` types the claim's role arrays loosely as `string[]` (rather than `Role[]`) because they come from an external, verified-but-untyped token — `hasPermission`/`isAdmin` validate the contents at read time.

## Delegated and programmatic service callers

`createServiceCallerVerifier` from `@unimatrix/auth/server` verifies OAuth access tokens and
user API keys independently of the browser-session guards. Pass the bearer credential to the
appropriate method explicitly; session cookies and platform administrator permissions do not
grant service capabilities. Each call requires a nonempty list of capabilities, all of which
must be recognized by the service and granted by the credential.

```ts
import { createServiceCallerVerifier } from "@unimatrix/auth/server";

const callers = createServiceCallerVerifier({
  secretKey: config.clerkSecretKey,
  publishableKey: config.clerkPublishableKey,
  jwtKey: config.clerkJwtKey,
  issuer: config.clerkIssuer,
  ownerUserId: config.ownerUserId,
  resource: config.resource,
  capabilities: ["canvas:read"],
});

const principal = await callers.verifyOAuthCaller(bearerToken, ["canvas:read"]);
// For a script credential, call callers.verifyApiKeyCaller instead.
```

The returned `ServicePrincipal` contains the verified user, credential/client identifiers,
resource and recognized capabilities. Its dependency-free type and `hasServiceCapability`
helper are exported from `@unimatrix/auth`. Pass the principal to in-process workflows;
never construct it from caller-supplied user IDs or scope lists.

OAuth requires an access-token JWT (`at+jwt` or `application/at+jwt`) signed by the configured
Clerk key, with the exact configured issuer and resource audience, valid time claims, and
explicit signed scopes (`scp` array or `scope` string). Verification also calls Clerk's
access-token verification endpoint on every request, checks current expiry/revocation, and
matches credential ID, subject and client against the signed claims. Capabilities must occur
in both the signed scopes and current provider scopes. Opaque OAuth tokens are rejected:
the installed SDK's verified resource object does not expose an audience or issuer.

API keys are verified online on every call using the configured Clerk instance. Provision
user-owned keys with explicit scopes and a backend-issued `claims.resource` equal to the
service's configured HTTPS resource identifier. Keys without that claim are rejected,
including keys created through UI flows that cannot attach it. An organization key's creator
does not make it a user-owned credential. Provider-managed keys with no expiration remain
valid until revoked; configured expirations are enforced. API keys have no JWT issuer claim;
the configured instance's authenticated verification endpoint establishes their provider.

Verification returns sanitized `AuthError` failures without provider messages, credentials,
claims or error causes. Invalid credentials, resource mismatches and provider failures return
401; a verified non-owner or insufficient capabilities returns 403. No successful principal
is cached across requests.

The signed-token and denial tests use synthetic credentials and mocked provider responses.
Configured-instance issuance, resource claims, consent, renewal, live revocation, enabled
features and ChatGPT/Codex compatibility still require the synthetic client proof in
`canvas.todo.md` before coursework integration. These tests do not establish provider or
client compatibility, and incompatible provider behavior requires an owner decision.

## Clerk Dashboard domain setup

- **Primary domain**: `unimatrix-01.dev`.
- **Satellite domains**: not needed. Every Unimatrix service is a subdomain of `unimatrix-01.dev` (e.g. `auth.unimatrix-01.dev`, `api.unimatrix-01.dev`), and Clerk shares session cookies across all subdomains of a primary domain automatically. Satellite domains exist for authenticating across *unrelated* domains, which does not apply here.

## Environment variables

This package never reads `process.env` itself — every value below is read by the consuming app and passed in explicitly (to `registerClerkAuth(app, options)` on the backend, or as props to `AuthProvider` on the frontend).

| Variable | Side | Used for |
| --- | --- | --- |
| `CLERK_SECRET_KEY` | backend (`apps/api`) | Backend API authentication (`registerClerkAuth`'s `secretKey`) |
| `CLERK_PUBLISHABLE_KEY` | backend (`apps/api`) | Deriving the Clerk Frontend API URL (`registerClerkAuth`'s `publishableKey`) |
| `CLERK_JWT_KEY` | backend (`apps/api`) | Networkless session JWT verification (`registerClerkAuth`'s `jwtKey`) |
| `VITE_CLERK_PUBLISHABLE_KEY` | frontend (`apps/auth`, `apps/admin`) | `AuthProvider`'s `publishableKey` prop |

These keys are provisioned by the repo owner in the Clerk Dashboard and are not committed. Local dev and tests can run without them — nothing in this package requires them to be set at import time; they are only required once `registerClerkAuth`/`AuthProvider` is actually invoked with them at app runtime.

## Bootstrapping the first admin

There is no public "become admin" endpoint or flow. To grant the first platform administrator:

- **Preferred**: in the Clerk Dashboard, open the user's profile and set `publicMetadata` to `{ "permissions": { "auth": ["admin"] } }`.
- **Alternative**: use a one-off script against `@clerk/backend`'s `clerkClient.users.updateUserMetadata(userId, { publicMetadata: { permissions: { auth: ["admin"] } } })` (this requires `CLERK_SECRET_KEY`; such a script does not belong to this package).

Once a user holds `auth: ["admin"]`, manage other users and their permission metadata directly in the Clerk Dashboard. This permission scheme still gates access across apps via `requirePermission` (server) and `usePermissions`/`isAdmin` (react).

## Usage sketch

```ts
// apps/api
import { registerClerkAuth, requirePermission } from "@unimatrix/auth/server";

await registerClerkAuth(app, {
  secretKey: env.CLERK_SECRET_KEY,
  publishableKey: env.CLERK_PUBLISHABLE_KEY,
  jwtKey: env.CLERK_JWT_KEY,
});

app.get("/admin/only", { preHandler: requirePermission("api", "admin") }, handler);
```

```tsx
// Excerpt from a Vite app's main.tsx. `runtimeConfig` is the app's own validated
// config, not shown: `apps/auth` loads it with `loadAuthAppRuntimeConfig`, and
// `apps/admin` builds it in main.tsx and passes it through the router context.
import { AuthProvider, usePermissions } from "@unimatrix/auth/react";

function Root() {
  return (
    <AuthProvider publishableKey={runtimeConfig.clerkPublishableKey}>
      <App />
    </AuthProvider>
  );
}

function AdminOnlyPanel() {
  const { isLoaded, isAdmin } = usePermissions();
  if (!isLoaded || !isAdmin()) return null;
  return <Panel />;
}
```

The key comes from the app's own validated config loader (`src/lib/config.ts`), never straight from `import.meta.env`.
