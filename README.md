# Unimatrix-01

Unimatrix-01 is the future TypeScript monorepo for the broader Unimatrix ecosystem.

This repository is intentionally starting from a **minimal foundation state** so it can receive a clean first commit and first push without accidental app scaffolding or premature complexity.

It is the active build target. If this repo is checked out beside `unimatrix-01-legacy/`, treat the legacy repo as reference material for content structure, tone, and historical context—not as the architecture to continue.

## Purpose

- host the public-facing site
- support projects, blog, docs, and notes
- provide room for shared UI, schemas, content tooling, and client packages
- preserve long-term monorepo boundaries from day one

## Relationship to the legacy repo

- `unimatrix-01/` is the future system and the only implementation target for new platform work
- `unimatrix-01-legacy/` is a Hugo-era reference repo for migration context, information architecture, and historical content patterns
- legacy implementation details should inform decisions only when they still fit the monorepo direction

## Current status

This repo currently includes the root monorepo foundation, shared config packages, the first baseline shared-package boundaries, and runnable shell workspaces for both web and API:

- `apps/`
- `packages/`
- `content/`
- `infra/`
- `packages/config-typescript`
- `packages/config-eslint`
- `packages/shared`
- `packages/api-client`
- `packages/content`
- `packages/db`
- `apps/web`
- `apps/api`
- `pnpm-workspace.yaml`
- `turbo.json`
- root package metadata and workspace scripts

The current app and package workspaces remain intentionally small, but `apps/web` now includes a runnable Vite + React scaffold shell, `apps/api` provides a minimal Fastify shell, and the shared package boundaries are in place so later web, API, and content work can extend them without restructuring.

## Branch and PR workflow

- use one issue branch per scoped piece of work
- prefer the Linear-suggested branch name when available
- keep PRs small and issue-aligned rather than bundling unrelated setup work
- use conventional commits
- avoid app or package scaffolding unless the issue explicitly asks for it
- run relevant validation before requesting review
- end PR descriptions with `Closes LOC-<issue-key>`

The root `AGENTS.md` is the repo-wide instruction file for now. Add deeper `AGENTS.md` files only when a subtree develops stable local rules that need to override the repo default.

## Planned direction

- package manager: `pnpm`
- monorepo orchestration: `Turborepo`
- frontend direction: ShadCN UI, preset `aJMzyTw`, Geist Mono, zero-radius styling, Remix Icons, ADHD-accessible constraints, desktop-first UX bias
- content direction: Git-based authored content with typed schemas, safe GFM rendering in the public site, and a future-safe Borg Markdown layer

## Typed content baseline

LOC-43 establishes the first repo-backed content workflow for the public site:

```text
content/
  home/
    index.md
  projects/
    *.md
  blog/
    *.md
```

Current in-scope domains are intentionally limited to:

- home/about
- projects
- blog

`docs` and `notes` remain out of scope for this issue even though the repo shape reserves space for them later.

### Current public route surface

- `/` for the overview, orientation, and public about/contact context
- `/projects` and `/projects/:slug` for the public project index and detail pages
- `/blog` and `/blog/:slug` for the public writing index and detail pages
- `/status` for the lightweight API-status surface

Unknown project or blog slugs intentionally resolve into the app's not-found experience instead of falling through to an unhandled content error.

### Authoring rules

- keep content Git-backed under `content/`
- use frontmatter that matches the typed collection contracts in `packages/content`
- expect invalid or missing fields to fail with file-specific validation errors
- authored content now renders with safe GitHub-flavored markdown in the public site
- raw HTML and executable MDX remain out of scope; Borg Markdown remains future work rather than part of this baseline
- keep the public v1 content set curated; legacy docs, policy pages, and operational queue-status posts stay out of scope unless a new issue expands that boundary
- when adding new `content/projects/*.md` or `content/blog/*.md` files, also wire them into `apps/web/src/features/content/site-content.ts`; `apps/web/test/content-registry.test.ts` guards this manual registry against omissions

### Validation commands

- `pnpm --filter @unimatrix/content lint`
- `pnpm --filter @unimatrix/content typecheck`
- `pnpm --filter @unimatrix/content test`
- `pnpm --filter @unimatrix/content build`
- `pnpm --filter @unimatrix/web lint`
- `pnpm --filter @unimatrix/web test:unit`
- `pnpm --filter @unimatrix/web test:smoke`
- `pnpm --filter @unimatrix/web typecheck`
- `pnpm --filter @unimatrix/web test`
- `pnpm --filter @unimatrix/web build`
- `pnpm check`

## Local setup

Use the pinned toolchain from the repo root:

```bash
corepack enable
corepack use pnpm@10.30.3
pnpm install
```

The root package metadata pins `pnpm@10.30.3`, enforces Node `22.x`, provides `.node-version` pinned to `22.22.1` for local version managers, and keeps workspace dependency resolution explicit through `.npmrc`.

For reproducible installs in automation or fresh clones, prefer `pnpm install --frozen-lockfile`.

Install Playwright Chromium once for local smoke runs:

```bash
pnpm --filter @unimatrix/web exec playwright install chromium
```

## App configuration

LOC-42 keeps environment configuration app-local on purpose. The current env surface is small and split across three execution contexts, so the validation helpers live with the apps instead of expanding `packages/shared` prematurely:

- `apps/api/src/config.ts` validates Fastify runtime config
- `apps/web/src/lib/config.ts` validates browser runtime config and the Vite dev-proxy target

Copy the example files before local development:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

Vite reads `apps/web/.env*` automatically for local development, so `VITE_API_BASE_URL` and `VITE_API_TARGET` can be configured there. The API entrypoints do **not** currently auto-load `apps/api/.env`, so treat that file as a documented template unless you explicitly source it or use a process manager / loader that exports those values into `process.env` before starting the API.

### `apps/api`

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `HOST` | no | `127.0.0.1` | Must be a non-empty host string when set. |
| `PORT` | no | `3001` | Must be an integer between `1` and `65535` when set. |
| `NODE_ENV` | no | `development` | Must be one of `development`, `test`, or `production`. |

### `apps/web`

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `VITE_API_BASE_URL` | no | `/api` | Must be either a site-relative path beginning with a single `/` or an absolute `http://` / `https://` URL. This value is exposed to the browser bundle. |
| `VITE_API_TARGET` | no | `http://127.0.0.1:3001` | Must be an absolute `http://` / `https://` URL. This is only used by the Vite dev server proxy and is not read from `import.meta.env` in the browser. |

Invalid or blank values now fail fast with explicit errors during API startup, Vite startup, or web app bootstrap rather than silently falling back to loose parsing.

Out of scope for LOC-42:

- repo-wide secret management
- deployment-specific env injection
- database configuration such as `DATABASE_URL`

## Agent and Automation Validation

Repo support remains pinned to Node `22.22.1` and pnpm `10.30.3`. CI already reads `.node-version` directly and runs on that supported toolchain without any wrapper.

If an agent or automation host is running a different Node major, do not treat that as expanded repo support. Use the checked-in bootstrap wrapper to enter the same Node 22 + pinned pnpm toolchain before running the canonical root commands:

```bash
./infra/scripts/pnpm-with-node22.sh install --frozen-lockfile
./infra/scripts/pnpm-with-node22.sh check
./infra/scripts/pnpm-with-node22.sh verify
```

This wrapper is only a bootstrap path for unsupported host runtimes such as Node 25 automation environments. Human local setup remains the standard Node 22 path above.
When the host already has local Node `22.x` and pnpm `10.30.3` active, the wrapper takes a fast path and reuses that local toolchain instead of bootstrapping `22.22.1` again.

## Commands

The root scripts are the canonical workspace entrypoints and proxy tasks through Turbo. `apps/web` now exposes real Vite `dev`, `build`, `preview`, `lint`, `test:unit`, `test:smoke`, `test`, and `typecheck` commands. `test:unit` intentionally runs the `@unimatrix/ui` build first because the markdown rendering tests import the published package entry from `packages/ui/dist/index.js`; that keeps `pnpm --filter @unimatrix/web test:unit` self-contained from a fresh checkout. `test:smoke` builds the web app and serves it through `vite preview`, so the smoke suite exercises the production artifact rather than Vite dev mode. The aggregate `test` command remains the canonical local and CI path for the web workspace: unit coverage plus a narrow Chromium smoke suite for `/`, a click-driven route navigation flow, `/projects/unimatrix-01`, and `/blog/building-a-typed-content-baseline`. The `/status` route is intentionally excluded from that smoke suite because it depends on the API surface and stays outside LOC-53 scope. `apps/api` provides its Fastify `dev`, `build`, `start`, `lint`, and `typecheck` commands.

```bash
pnpm dev
pnpm build
pnpm lint
pnpm test
pnpm typecheck
pnpm check
pnpm verify
pnpm --filter @unimatrix/api dev
pnpm --filter @unimatrix/web dev
pnpm --filter @unimatrix/web test:smoke
pnpm --filter @unimatrix/web test
```

## Quality gates

Use the root scripts as the reproducible quality gates for all work in this repo:

- `pnpm lint` for static analysis
- `pnpm typecheck` for TypeScript validation
- `pnpm test` for automated test suites
- `pnpm check` for the default pre-review gate (`lint`, `typecheck`, `test`)
- `pnpm verify` for the fuller local release gate (`build` plus `check`)

Run `pnpm verify` before requesting review unless a scoped package or app defines a narrower command set and the PR only touches that surface area.

## GitHub Actions CI

GitHub Actions validates this monorepo on branch pushes. For this repo's same-branch PR workflow, those checks surface directly on the pull request, which avoids duplicate push and pull-request runs for the same commit.

The baseline CI workflow uses the pinned repo toolchain:

- Node `22.22.1` from `.node-version`
- pnpm `10.30.3`
- `pnpm install --frozen-lockfile`

The workflow then runs the canonical root validation commands as separate steps:

- `pnpm build`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

Before the `pnpm test` step, CI installs Playwright Chromium for `@unimatrix/web` so the root test path can run the public-site smoke suite without a separate workflow job.

This keeps CI aligned with the local quality gates instead of introducing a separate automation-only command surface.

## Shared config packages

`packages/config-typescript` provides strict shared baselines:

- `base.json`
- `library.json`
- `vite-app.json`

The defaults enforce `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, and `isolatedModules`.
The `library.json` preset also enables declaration-oriented library settings with `composite`, `declaration`, and `declarationMap`.

`packages/config-eslint` provides flat-config helpers for typed package and app linting. Consumers pass their own `tsconfigRootDir` so type-aware linting resolves from the consuming workspace rather than the config package.

Current typed consumers of the shared config path live in:

- `packages/shared`
- `packages/api-client`
- `packages/content`
- `apps/web`
- `apps/api`

Each consumer declares the shared config packages in `devDependencies`, extends the TypeScript config in `tsconfig.json`, and imports the ESLint helper from `eslint.config.mjs`.

## Shared baseline packages

The first reusable package boundaries are now explicit:

- `@unimatrix/shared` for shared schemas, contracts, and framework-agnostic types
- `@unimatrix/api-client` for typed client and transport primitives
- `@unimatrix/content` for typed content collections, schemas, and content-loading helpers
- `@unimatrix/db` for Drizzle ORM, SQLite configuration, and migration tooling

Most of these packages currently expose explicit placeholder `test` scripts so `pnpm test` exercises the workspace contract consistently until LOC-52 adds broader package-level test coverage. `@unimatrix/db` now includes a real SQLite smoke test plus migration scripts for the local persistence baseline.

## Repository shape

```text
.
├── apps/
│   ├── api/
│   └── web/
├── content/
├── infra/
├── packages/
│   ├── config-eslint/
│   ├── config-typescript/
│   ├── shared/
│   ├── api-client/
│   ├── content/
│   └── db/
├── AGENTS.md
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```
