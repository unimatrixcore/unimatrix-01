# AGENTS.md

## 1. Overview
`packages/auth` is the shared Clerk-backed authentication and permission-scheme boundary for the monorepo. It defines the single source of truth for how permissions are shaped and stored, plus thin Fastify and React integration layers built on top of it.

## 2. Folder Structure
- `src/permissions.ts`: framework-agnostic permission scheme — `AppSlug`, `Role`, the `UserPermissionsMetadata`/`SessionPermissionsClaim` shapes, and the `hasPermission`/`isAdmin` pure helpers.
- `src/index.ts`: barrel for the `.` entry point (re-exports `permissions.ts`).
- `src/server.ts`: the `./server` entry point — `registerClerkAuth` (wraps `@clerk/fastify`'s `clerkPlugin`), `requireAuth`/`requirePermission` preHandler guards, `getAuthUserId`, `getSessionPermissionsClaim`, and the `AuthError` class. Re-exports `src/admin.ts`. Node-only.
- `src/admin.ts`: user-management helpers built on `@clerk/backend`'s `createClerkClient` — `createUserManagementClient` (`listUsers`/`getUser`/`setUserPermissions`) and the `UserSummaryData` type, re-exported from `./server`. Never imported by `./react`.
- `src/react.tsx`: the `./react` entry point — `AuthProvider` (wraps `@clerk/clerk-react`'s `ClerkProvider`), the `usePermissions` hook, and thin re-exports of commonly used Clerk components/hooks. Browser-only.
- `test/permissions.test.ts`: coverage for the pure `.` helpers, including malformed-input handling.
- `test/admin.test.ts`: coverage for `src/admin.ts`'s pure `normalizePermissionsMetadata` helper, including malformed-input handling.

## 3. Core Behaviors & Patterns
- **Three isolated entry points**: `.` is zero-runtime-dependency and safe to import anywhere; `./server` is Node-only and depends on `@clerk/fastify`/`fastify`; `./react` is browser-only and depends on `@clerk/clerk-react`/`react`. Never import `./server` from `./react` or vice versa, and never add a runtime dependency to `.`.
- **No `process.env` reads inside this package**: every Clerk key (`secretKey`, `publishableKey`, `jwtKey`, `publishableKey` for the frontend) is passed in explicitly by the consuming app through function/prop options. This keeps the package portable across `apps/api`, `apps/web`, and `apps/auth`.
- **Single source of truth for permission shape**: `UserPermissionsMetadata` (Clerk `publicMetadata`) and `SessionPermissionsClaim` (the custom JWT claim) are both defined once in `src/permissions.ts`. `./server` and `./react` both build on the same `hasPermission`/`isAdmin` helpers rather than re-implementing permission checks.
- **`AuthError` is designed to be caught downstream**: it exposes `kind`, `statusCode`, and `code` so a later phase can map it into `apps/api`'s `ApiError`/`normalizeError` pattern without this package importing from `apps/api` (that would be circular).
- **`UserSummaryData` mirrors `@unimatrix/shared`'s `userSummarySchema` by convention, not by import**: this package must never depend on `@unimatrix/shared` (dependency direction stays one-way: `apps/api` depends on both). Keep the two shapes' field names identical by hand so `apps/api` can map `UserSummaryData` straight onto the shared contract's response shape.

## 4. Conventions
- **Naming**: `require*` for Fastify preHandler factories, `has*`/`is*` for pure permission predicates, `use*` for the React hook.
- **Types**: Keep the permission scheme's exported types (`AppSlug`, `Role`, `UserPermissionsMetadata`, `SessionPermissionsClaim`) as the canonical shapes; don't redefine permission shapes locally in consuming apps.
- **Structure**: Add new framework-agnostic permission logic to `src/permissions.ts`; add new Fastify-specific behavior to `src/server.ts`; add new React-specific behavior to `src/react.tsx`. Don't collapse the three entry points into one file.

## 5. Working Agreements
- Follow the shared repo working agreements in the root `AGENTS.md`; this file only adds `packages/auth` structure, patterns, and conventions.
