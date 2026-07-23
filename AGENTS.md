# Agent Instructions

## Package Manager
- Use **pnpm** with Node `22.22.1` and pnpm `10.30.3`
- Canonical root commands: `pnpm install`, `pnpm dev`, `pnpm setup:local`, `pnpm setup:worktree`, `pnpm check`, `pnpm verify`
- Full root surface: `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm typecheck`, `pnpm db:migrate`, `pnpm db:generate`
- Repro install: `pnpm install --frozen-lockfile`
- If host Node/pnpm mismatch: `./infra/scripts/pnpm-with-node22.sh <pnpm-args>`

## Workspace
- Monorepo: `apps/*` and `packages/*` from `pnpm-workspace.yaml`; root scripts fan out through Turbo
- Live apps: `apps/web` (Vite + React + TanStack Router public site), `apps/api` (Fastify API), `apps/cube-trainer` (Vite + React + TanStack Router OLL/PLL algorithm trainer, no backend dependency), `apps/auth` (package `@unimatrix/auth-app`; Vite + React + TanStack Router central auth hub for `auth.unimatrix-01.dev`: sign-in/up and account settings; user/permission management is done in the Clerk Dashboard, not in-app)
- Live packages: `packages/ui`, `packages/shared`, `packages/api-client`, `packages/content`, `packages/db`, `packages/auth` (shared Clerk auth + permission scheme), `packages/user-data` (per-user account/guest data store), `packages/config-typescript`, `packages/config-eslint`
- Live content: `content/home`, `content/projects`, `content/blog`
- Repo-internal docs: `docs/`; infra/runtime helpers: `infra/scripts`, `infra/deployment`, `infra/docker`
- Reserved, not live: `apps/workers`, `content/docs`, `content/notes`, future packages like `packages/bmd-parser`
- Keep repo facts current-first; do not treat reserved paths as active runtime surface
- Nearest nested `AGENTS.md` overrides this file

## Workspace Responsibilities
- `apps/web`: route-driven public site, public content rendering, app-owned public-site compositions
- `apps/api`: runtime config validation, Fastify plugins, feature route modules, HTTP error normalization
- `apps/cube-trainer`: OLL/PLL algorithm browse and flashcard-trainer UI, bundled algorithm data, `localStorage`-backed progress
- `apps/auth`: central Clerk auth hub — sign-in/up and account settings (`UserProfile`); redirect target for other services' sign-in. User/permission management lives in the Clerk Dashboard, so the app ships no admin panel (the `packages/auth` permission scheme still gates other apps)
- `packages/ui`: shared shadcn primitives, shared styles, safe markdown rendering, `@unimatrix/ui/public`
- `packages/shared`: framework-agnostic API contracts, Zod schemas, exported shared types only
- `packages/api-client`: typed fetch transport consuming `@unimatrix/shared` contracts; pluggable `getAuthToken` provider
- `packages/content`: pure parsing, frontmatter validation, repo-backed loaders for live public content only
- `packages/db`: Drizzle + SQLite persistence, schema barrel, migrations, local DB path resolution
- `packages/auth`: single source of truth for the permission scheme (`.`), Clerk Fastify guards (`./server`), and Clerk React provider/hooks (`./react`); never reads `process.env`
- `packages/user-data`: unified per-user store (settings as JSON documents, files as blobs) with an account adapter (via `@unimatrix/api-client`) and a browser-only IndexedDB guest adapter

## File-Scoped Commands
| Task | Command |
| --- | --- |
| Lint one file | `pnpm exec eslint path/to/file.ts` |
| Web unit test file | `pnpm --filter @unimatrix/web exec vitest run path/to/test.tsx` |
| API test file | `pnpm --filter @unimatrix/api exec node --import tsx --test path/to/test.ts` |
| Package test file | `pnpm --filter <workspace> exec vitest run path/to/test.ts` |
| Web typecheck | `pnpm --filter @unimatrix/web typecheck` |
| API typecheck | `pnpm --filter @unimatrix/api typecheck` |
| Cube Trainer test file | `pnpm --filter @unimatrix/cube-trainer exec vitest run path/to/test.ts` |
| Cube Trainer typecheck | `pnpm --filter @unimatrix/cube-trainer typecheck` |
| Auth app test file | `pnpm --filter @unimatrix/auth-app exec vitest run path/to/test.ts` |
| Auth app typecheck | `pnpm --filter @unimatrix/auth-app typecheck` |
| Auth package test/typecheck | `pnpm --filter @unimatrix/auth test` / `pnpm --filter @unimatrix/auth typecheck` |
| User-data package test/typecheck | `pnpm --filter @unimatrix/user-data test` / `pnpm --filter @unimatrix/user-data typecheck` |

## Runtime And Bootstrap
- `pnpm dev` starts only `@unimatrix/api` and `@unimatrix/web`; run `pnpm --filter @unimatrix/cube-trainer dev` (port 5173) and `pnpm --filter @unimatrix/auth-app dev` (port 5175) separately
- `pnpm dev` creates missing `apps/api/.env` and `apps/web/.env` from example files
- `pnpm setup:local` only copies missing env files; it never overwrites existing local env
- `pnpm setup:worktree` runs frozen install, env bootstrap, and default DB migrations; use it for fresh worktrees
- API loads `apps/api/.env.local` first, then `apps/api/.env`; existing shell env wins
- API auth is opt-in: `CLERK_SECRET_KEY`/`CLERK_PUBLISHABLE_KEY`/`CLERK_JWT_KEY` are required in production but optional in dev/test (the API boots with auth + the user-data routes disabled when they are absent); `MAX_UPLOAD_BYTES` defaults to 5 MiB
- Web uses normal Vite `apps/web/.env*` behavior; Clerk is optional there (`VITE_CLERK_PUBLISHABLE_KEY` enables it, `VITE_AUTH_APP_URL` points at the auth hub)
- auth app needs `VITE_CLERK_PUBLISHABLE_KEY` (required) and `VITE_API_BASE_URL` (default `/api`); cube-trainer has no `.env` files and no backend dependency
- CI uses the same root commands and installs Playwright Chromium for web and cube-trainer smoke coverage (the auth app ships unit tests only — no smoke suite, since it needs live Clerk keys)

## Boundaries
- `apps/web`: keep route data in non-lazy route files and UI in paired `*.lazy.tsx`; `src/routes/routeTree.gen.ts` is generated
- `apps/web`: prefer `@unimatrix/ui/public`; keep public-site compositions in `src/features/public-site`; keep site-only styling in `src/styles.css`
- `apps/web`: safe markdown only; keep raw HTML and runtime MDX disabled
- `apps/api`: keep `buildApp()` wiring in `src/app.ts`, cross-cutting setup in `src/plugins`, feature routes in `src/modules`, reusable HTTP helpers in `src/lib/http`; verify Clerk tokens networklessly via the `@unimatrix/auth/server` plugin/guards and read the acting user only from the verified session (`getAuthUserId`), never from client input
- `apps/cube-trainer`: keep the same non-lazy/`*.lazy.tsx` route split as `apps/web`; do not add `@unimatrix/api-client`, `@unimatrix/shared`, `@unimatrix/content`, or `@tanstack/react-query` dependencies unless a real server-backed feature is added
- `apps/auth`: same non-lazy/`*.lazy.tsx` route split as `apps/web`; consume Clerk only through `@unimatrix/auth/react` (never `@clerk/clerk-react` directly); validate any inbound `redirect_url` against the same-family allowlist before use
- `packages/shared`: no transport code, UI code, or content-loading logic; `ApiContract` paths stay static (no path params) — use query/body schemas instead
- `packages/api-client`: do not redefine endpoints or response shapes locally; consume `@unimatrix/shared`; stays auth-library-agnostic (the consumer supplies `getAuthToken`) and DOM/Node-lib-free
- `packages/content`: keep loaders synchronous and filesystem-based unless the package boundary intentionally changes
- `packages/db`: schema under `src/schema`, migrations under `drizzle`, default DB at `packages/db/local/unimatrix.sqlite`
- `packages/auth`: keep the three entry points separate — `.` stays framework-agnostic and dependency-free, `./server` is Node-only, `./react` is browser-only; never cross-import server and react; the package takes config as arguments and never reads `process.env`
- `packages/user-data`: keep the account and guest adapters behind the same store interface so services stay storage-agnostic; do binary file I/O here (not in `@unimatrix/api-client`); key all account data by the caller's session, never by client-provided ids

## Key Conventions
- TypeScript only; keep strict typing, named exports, and small composable modules
- Keep package boundaries stable instead of duplicating logic app-locally
- Validate every external input boundary with Zod
- Shared request/response shapes belong in `@unimatrix/shared`; do not redefine them in apps or transport code
- API routes should be contract-driven via `@unimatrix/shared`; keep handlers thin and error formatting centralized
- Use explicit exported types at boundaries instead of anonymous inline shapes
- Public-site UI preserves ShadCN UI, preset `aJMzyTw`, Geist Mono, zero-radius styling, Remix Icons, ADHD-accessible UX, and a desktop-first bias
- Prefer app-local composition over widening shared packages unless multiple workspaces truly need the abstraction
- Content stays Git-backed markdown with safe rendering only; never execute raw HTML, executable MDX, or generated code from `content/`
- Adding `content/projects/*.md` or `content/blog/*.md` requires updating `apps/web/src/features/content/site-content.ts`
- `docs/` is contributor/agent guidance, not public site content

## Validation
- Run the narrowest relevant checks for the files you changed
- Use `pnpm check` as the normal pre-review gate
- Use `pnpm verify` when changes span multiple workspaces or affect runtime/build behavior
- Web-specific deeper checks: `pnpm --filter @unimatrix/web test:unit`, `pnpm --filter @unimatrix/web test:smoke`
- Cube Trainer deeper checks: `pnpm --filter @unimatrix/cube-trainer test:unit`, `pnpm --filter @unimatrix/cube-trainer test:smoke`
- Auth app deeper checks: `pnpm --filter @unimatrix/auth-app test` (unit only), `pnpm --filter @unimatrix/auth-app build`
- Auth / user-data package checks: `pnpm --filter @unimatrix/auth test`, `pnpm --filter @unimatrix/user-data test`

## Git And PR Rules
- Keep PRs small and issue-aligned; avoid unrelated scaffolding or setup churn
- Use one issue branch per scoped piece of work; prefer the Linear-suggested branch name when one exists
- Use conventional commits
- End PR bodies with `Closes LOC-<issue-key>` when applicable

## Commit Attribution
AI commits MUST include:
```
Co-Authored-By: Claude <noreply@anthropic.com>
```
