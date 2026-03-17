# AGENTS.md

## 1. Overview
`unimatrix-01` is the active TypeScript monorepo for the Unimatrix public site, API, shared workspace packages, and repo-backed authored content. Keep changes current-first: stay inside the live surface, and treat reserved paths as future scope until an issue explicitly activates them.

## 2. Folder Structure
- `apps`: runnable applications.
  - `web`: Vite + React public site, TanStack Router routes, public content rendering, and browser tests.
  - `api`: Fastify API with validated runtime config, shared contracts, core plugins, and route modules.
- `packages`: shared workspace boundaries.
  - `ui`: shared shadcn-based primitives, shared styles, and safe markdown rendering.
  - `shared`: framework-agnostic contracts, Zod schemas, and reusable types.
  - `api-client`: typed transport helpers that consume `@unimatrix/shared` contracts.
  - `content`: typed content parsing, frontmatter validation, and repo-backed loaders.
  - `db`: Drizzle + SQLite persistence helpers, schema exports, and migrations.
  - `config-typescript`: shared TypeScript baselines for apps and libraries.
  - `config-eslint`: shared ESLint flat-config factories for apps and packages.
- `content`: public authored markdown rendered by `apps/web`.
  - `home`: homepage and about copy.
  - `projects`: public project entries.
  - `blog`: public blog entries.
- `docs`: repo-internal operating docs, workspace maps, and contributor guidance.
- `infra`: workflow helpers and deployment guidance.
  - `scripts`: local setup and dev entrypoints.
  - `deployment`: deployment contract and environment guidance.
  - `docker`: local container posture and related docs.
- Reserved surface: `apps/workers`, `content/docs`, `content/notes`, and future packages such as `packages/bmd-parser` stay out of normal work unless an issue expands the boundary.

## 3. Working Agreements
- Treat the root scripts as the canonical workflow surface; use `pnpm`, and fall back to `./infra/scripts/pnpm-with-node22.sh` if local Node or pnpm do not match the pinned versions.
- Keep work inside existing app and package boundaries; prefer shared packages over app-local duplication only when multiple workspaces genuinely need the abstraction.
- Validate external input boundaries with Zod, keep API handlers thin, and carry shared request or response shapes through `@unimatrix/shared` instead of redefining them locally.
- Preserve the frontend system in `apps/web`: ShadCN UI, preset `aJMzyTw`, Geist Mono, zero-radius styling, Remix Icons, ADHD-accessible UX, and a desktop-first bias.
- Keep public content Git-backed and safe-rendered; do not introduce raw HTML, executable MDX, or generated-code execution into the authored content path.
- When adding `content/projects/*.md` or `content/blog/*.md`, update `apps/web/src/features/content/site-content.ts` in the same change so the explicit registry remains accurate.
- Ask first before changing pnpm, Vite, Fastify, Turborepo, moving off SQLite without a demonstrated need, introducing a headless CMS, or making major package-boundary changes.

## Package manager
- Use `pnpm`.
- Core commands: `pnpm install`, `pnpm setup:local`, `pnpm dev`,
  `pnpm check`, `pnpm verify`.
- If local Node or pnpm do not match `.node-version` and the root
  `packageManager` field, use
  `./infra/scripts/pnpm-with-node22.sh ...`.

## Source of truth
- Human docs: `docs/README.md`.
- Deployment contract: `infra/deployment/README.md`.
- Package boundaries: package-level `README.md` files under `packages/`.
- The nearest `AGENTS.md` overrides this file.

## Live surface
- Apps: `apps/web`, `apps/api`
- Packages: `packages/ui`, `packages/shared`, `packages/api-client`,
  `packages/content`, `packages/db`, `packages/config-typescript`,
  `packages/config-eslint`
- Content: `content/home`, `content/projects`, `content/blog`
- Ops/docs: `docs/`, `infra/scripts`, `infra/deployment`, `infra/docker`

## Reserved, not live
- `apps/workers`
- `content/docs`
- `content/notes`
- Future packages such as `packages/bmd-parser`

## Scoped commands
| Task | Command |
| --- | --- |
| Lint one file | `pnpm exec eslint path/to/file.ts` |
| Run one web unit test file | `pnpm --filter @unimatrix/web exec vitest run path/to/test.tsx` |
| Run one API test file | `pnpm --filter @unimatrix/api exec node --import tsx --test path/to/test.ts` |
| Typecheck one workspace | `pnpm --filter @unimatrix/web typecheck` or `pnpm --filter @unimatrix/api typecheck` |

## Repo rules
- Use TypeScript, strict typing, named exports, and small composable
  modules.
- Prefer stable package boundaries over app-local duplication.
- Validate every external input boundary with Zod.
- Keep API handlers thin and move business logic into service modules.
- Preserve the frontend system: ShadCN UI, preset `aJMzyTw`, Geist Mono,
  zero-radius styling, Remix Icons, ADHD-accessible UX, and a
  desktop-first bias.
- Keep content Git-backed and safe-rendered. Never execute raw HTML, MDX,
  or generated code.
- When adding `content/projects/*.md` or `content/blog/*.md`, update
  `apps/web/src/features/content/site-content.ts` in the same change.
- Treat `docs/` as repo-internal guidance and `content/` as public site
  content.

## Validation
- Minimum gate: `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- Use `pnpm verify` for cross-workspace or runtime-surface changes.

## Ask first
- Switching away from Vite, Fastify, pnpm, or Turborepo
- Moving from SQLite to Postgres before a real need exists
- Introducing a headless CMS
- Making major package-boundary changes

## Commit attribution
- If you are a Codex agent and you create commits, add
  `Co-Authored-By: Codex <noreply@openai.com>`.
- If you are a Claude Code agent and you create commits, add
  `Co-Authored-By: Claude <noreply@anthropic.com>`.
