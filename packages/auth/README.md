# @unimatrix/auth

Shared Clerk-backed authentication and permission scheme for the Unimatrix monorepo. This package defines the single source of truth for how permissions are shaped and stored, plus thin Fastify and React integration layers on top of it.

All Unimatrix services are subdomains of `unimatrix-01.dev`. Clerk's primary domain is `unimatrix-01.dev`, sessions are shared across every subdomain automatically, and **no satellite domains are configured or needed**.

## Entry points

| Import path | Runtime | Contents |
| --- | --- | --- |
| `@unimatrix/auth` | any (zero runtime deps) | `AppSlug`, `Role`, `UserPermissionsMetadata`, `SessionPermissionsClaim`, `hasPermission`, `isAdmin` |
| `@unimatrix/auth/server` | Node (Fastify 5) | `registerClerkAuth`, `requireAuth`, `requirePermission`, `getAuthUserId`, `getSessionPermissionsClaim`, `AuthError` |
| `@unimatrix/auth/react` | browser (React 19) | `AuthProvider`, `usePermissions`, plus re-exports of `SignIn`, `SignUp`, `UserButton`, `UserProfile`, `SignedIn`, `SignedOut`, `RedirectToSignIn`, `useAuth`, `useUser` |

Use `.` from anywhere you only need types or the pure permission-check helpers (e.g. shared validation logic). Use `./server` only in `apps/api` (or another Fastify backend). Use `./react` only in a Vite/React frontend (`apps/web`, `apps/cube-trainer`, a future `apps/auth`).

## Permission scheme

Permissions are stored in Clerk `user.publicMetadata` under a single `permissions` key, mapping each app slug to the roles the user holds for that app. This is the **single source of truth** — nothing else stores or derives permissions independently.

```json
{
  "permissions": {
    "web": ["viewer"],
    "cube-trainer": ["viewer", "editor"],
    "auth": ["admin"]
  }
}
```

- App slugs: `"web"`, `"cube-trainer"`, `"auth"`, `"api"` (see `AppSlug`).
- Roles: `"viewer"`, `"editor"`, `"admin"` (see `Role`).
- The platform-wide administrator role is `auth: ["admin"]` — `isAdmin(perms)` is shorthand for `hasPermission(perms, "auth", "admin")`.

`publicMetadata` can only be written from the Backend API (`@clerk/backend`, added in a later phase), never from the client. There is intentionally no public "become admin" flow.

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
| `VITE_CLERK_PUBLISHABLE_KEY` | frontend (`apps/web`, `apps/cube-trainer`, future `apps/auth`) | `AuthProvider`'s `publishableKey` prop |

These keys are provisioned by the repo owner in the Clerk Dashboard and are not committed. Local dev and tests can run without them — nothing in this package requires them to be set at import time; they are only required once `registerClerkAuth`/`AuthProvider` is actually invoked with them at app runtime.

## Bootstrapping the first admin

There is no public "become admin" endpoint or flow. To grant the first platform administrator:

- **Preferred**: in the Clerk Dashboard, open the user's profile and set `publicMetadata` to `{ "permissions": { "auth": ["admin"] } }`.
- **Alternative**: use a one-off script against `@clerk/backend`'s `clerkClient.users.updateUserMetadata(userId, { publicMetadata: { permissions: { auth: ["admin"] } } })` (this requires `CLERK_SECRET_KEY`; such a script belongs to a later phase's tooling, not to this package).

Once a user holds `auth: ["admin"]`, later phases can build an admin UI (in a future `apps/auth`) that lets them manage other users' permissions through the Backend API.

## Usage sketch

```ts
// apps/api (later phase)
import { registerClerkAuth, requirePermission } from "@unimatrix/auth/server";

await registerClerkAuth(app, {
  secretKey: env.CLERK_SECRET_KEY,
  publishableKey: env.CLERK_PUBLISHABLE_KEY,
  jwtKey: env.CLERK_JWT_KEY,
});

app.get("/admin/only", { preHandler: requirePermission("api", "admin") }, handler);
```

```tsx
// apps/web (later phase)
import { AuthProvider, usePermissions } from "@unimatrix/auth/react";

function Root() {
  return (
    <AuthProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}>
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
