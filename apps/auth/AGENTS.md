# AGENTS.md

## 1. Overview
`apps/auth` (package `@unimatrix/auth-app`) is the Vite + React + TanStack Router SPA that serves the central authentication hub at `auth.unimatrix-01.dev`. It hosts sign-in/sign-up and account settings. Other services (e.g. `apps/web`) redirect unauthenticated users here and are returned afterward. Clerk sessions are shared automatically across `*.unimatrix-01.dev` subdomains, so there is no token passing — the auth app only establishes the session.

## 2. Folder Structure
- `src/app`: `AuthProvider`/query providers, router creation, and the minimal app shell — a full-height container that just centers each route's Clerk widget or card. No header, nav, or `UserButton`; the `UserButton` lives on the services, not here.
- `src/lib`: `config.ts` (runtime env validation — requires `VITE_CLERK_PUBLISHABLE_KEY`; `VITE_API_BASE_URL` defaults to `/api`; dev-only `VITE_API_TARGET` defaults to `http://127.0.0.1:3001` and is used by `vite.config.ts` to proxy `/api` during `pnpm --filter @unimatrix/auth-app dev`), `query-client.ts`, and `api-client.ts` (the `useApiClient()` hook that wires Clerk's session `getToken()` into `@unimatrix/api-client`).
- `src/features/auth`: `safe-redirect.ts` — the open-redirect allowlist for the inbound `redirect_url` param.
- `src/routes`: file-based routes with paired `*.tsx` (route data / `validateSearch`) and `*.lazy.tsx` (components): `index` (sign-in/up card, or redirect to `/account` when signed in), `sign-in`, `sign-up`, `account`. `routeTree.gen.ts` is generated — never hand-edit it.
- `src/styles.css`: app presentation layered on `@unimatrix/ui/styles.css`.
- `test`: Vitest coverage (config validation, redirect allowlist).

## 3. Core Behaviors & Patterns
- **Consume Clerk only via `@unimatrix/auth/react`** (`AuthProvider`, `usePermissions`, `SignIn`, `SignUp`, `UserProfile`, `UserButton`, `RedirectToSignIn`, etc.) — never import `@clerk/clerk-react` directly.
- **Session token, not templates**: `useApiClient()` attaches a plain `getToken()` session token; the `permissions` claim rides the session token via Clerk's session-token customization (see `packages/auth/README.md`).
- **Redirect-back is validated**: `/sign-in` and `/sign-up` read an inbound `redirect_url`, pass it to Clerk's `forceRedirectUrl`, but only after `safeRedirectUrl` confirms it is a `*.unimatrix-01.dev` (https) or localhost origin — otherwise it falls back to the auth landing. Never widen this allowlist without care.
- **Clerk component routing** uses `routing="hash"` to keep sub-steps on one route without splat routes.

## 4. Conventions
- **Route files**: TanStack Router file naming with paired `*.tsx` + `*.lazy.tsx`, matching `apps/web`; keep route data (loaders, `validateSearch`) in the non-lazy file and UI in the lazy file.
- **Imports**: external first, then `@/` aliases, then relative. Prefer `@unimatrix/ui/public`.
- **Naming**: `PascalCase` components; `camelCase` helpers exported from kebab-case files.
- **Dependencies**: this app depends on `@unimatrix/auth`, `@unimatrix/api-client`, `@unimatrix/shared`, `@unimatrix/ui`, and `@tanstack/react-*`; it is not part of `pnpm dev` (run it with `pnpm --filter @unimatrix/auth-app dev`, port 5175). Tests are unit-only (no Playwright smoke — that would need live Clerk keys).

## 5. Working Agreements
- Follow the shared repo working agreements in the root `AGENTS.md`; this file only adds `apps/auth` structure, patterns, and conventions.
