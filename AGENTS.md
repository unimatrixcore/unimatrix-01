# Agent Instructions

## Package Manager
- Use **pnpm** with Node `22.22.1` and pnpm `10.30.3`
- Canonical root commands: `pnpm install`, `pnpm dev`, `pnpm setup:local`, `pnpm setup:worktree`, `pnpm check`, `pnpm verify`
- Full root surface: `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm typecheck`, `pnpm db:migrate`, `pnpm db:generate`
- Repro install: `pnpm install --frozen-lockfile`
- If host Node/pnpm mismatch: `./infra/scripts/pnpm-with-node22.sh <pnpm-args>`

## Workspace
- Monorepo: `apps/*` and `packages/*` from `pnpm-workspace.yaml`; root scripts fan out through Turbo
- Live apps: `apps/web` (Vite + React + TanStack Router public site), `apps/api` (Fastify API)
- Live packages: `packages/ui`, `packages/shared`, `packages/api-client`, `packages/content`, `packages/db`, `packages/config-typescript`, `packages/config-eslint`
- Live content: `content/home`, `content/projects`, `content/blog`
- Repo-internal docs: `docs/`; infra/runtime helpers: `infra/scripts`, `infra/deployment`, `infra/docker`
- Reserved, not live: `apps/workers`, `content/docs`, `content/notes`, future packages like `packages/bmd-parser`
- Keep repo facts current-first; do not treat reserved paths as active runtime surface
- Nearest nested `AGENTS.md` overrides this file

## Workspace Responsibilities
- `apps/web`: route-driven public site, public content rendering, app-owned public-site compositions
- `apps/api`: runtime config validation, Fastify plugins, feature route modules, HTTP error normalization
- `packages/ui`: shared shadcn primitives, shared styles, safe markdown rendering, `@unimatrix/ui/public`
- `packages/shared`: framework-agnostic API contracts, Zod schemas, exported shared types only
- `packages/api-client`: typed fetch transport consuming `@unimatrix/shared` contracts
- `packages/content`: pure parsing, frontmatter validation, repo-backed loaders for live public content only
- `packages/db`: Drizzle + SQLite persistence, schema barrel, migrations, local DB path resolution

## File-Scoped Commands
| Task | Command |
| --- | --- |
| Lint one file | `pnpm exec eslint path/to/file.ts` |
| Web unit test file | `pnpm --filter @unimatrix/web exec vitest run path/to/test.tsx` |
| API test file | `pnpm --filter @unimatrix/api exec node --import tsx --test path/to/test.ts` |
| Package test file | `pnpm --filter <workspace> exec vitest run path/to/test.ts` |
| Web typecheck | `pnpm --filter @unimatrix/web typecheck` |
| API typecheck | `pnpm --filter @unimatrix/api typecheck` |

## Runtime And Bootstrap
- `pnpm dev` starts only `@unimatrix/api` and `@unimatrix/web`
- `pnpm dev` creates missing `apps/api/.env` and `apps/web/.env` from example files
- `pnpm setup:local` only copies missing env files; it never overwrites existing local env
- `pnpm setup:worktree` runs frozen install, env bootstrap, and default DB migrations; use it for fresh worktrees
- API loads `apps/api/.env.local` first, then `apps/api/.env`; existing shell env wins
- Web uses normal Vite `apps/web/.env*` behavior
- CI uses the same root commands and installs Playwright Chromium for web smoke coverage

## Boundaries
- `apps/web`: keep route data in non-lazy route files and UI in paired `*.lazy.tsx`; `src/routes/routeTree.gen.ts` is generated
- `apps/web`: prefer `@unimatrix/ui/public`; keep public-site compositions in `src/features/public-site`; keep site-only styling in `src/styles.css`
- `apps/web`: safe markdown only; keep raw HTML and runtime MDX disabled
- `apps/api`: keep `buildApp()` wiring in `src/app.ts`, cross-cutting setup in `src/plugins`, feature routes in `src/modules`, reusable HTTP helpers in `src/lib/http`
- `packages/shared`: no transport code, UI code, or content-loading logic
- `packages/api-client`: do not redefine endpoints or response shapes locally; consume `@unimatrix/shared`
- `packages/content`: keep loaders synchronous and filesystem-based unless the package boundary intentionally changes
- `packages/db`: schema under `src/schema`, migrations under `drizzle`, default DB at `packages/db/local/unimatrix.sqlite`

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

## Git And PR Rules
- Keep PRs small and issue-aligned; avoid unrelated scaffolding or setup churn
- Use one issue branch per scoped piece of work; prefer the Linear-suggested branch name when one exists
- Use conventional commits
- End PR bodies with `Closes LOC-<issue-key>` when applicable

## Commit Attribution
AI commits MUST include:
```
Co-Authored-By: OpenCode <noreply@opencode.ai>
```
