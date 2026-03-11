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

This repo currently includes the root monorepo foundation, shared config packages, the first baseline shared-package boundaries, and minimal app shells for both web and API:

- `apps/`
- `packages/`
- `content/`
- `infra/`
- `packages/config-typescript`
- `packages/config-eslint`
- `packages/shared`
- `packages/api-client`
- `packages/content`
- `apps/web`
- `apps/api`
- `pnpm-workspace.yaml`
- `turbo.json`
- root package metadata and workspace scripts

The current app and package workspaces remain intentionally small, but the shared package boundaries and app shells are now in place so later web, API, and content work can extend them without restructuring.

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
- content direction: Git-based authored content with typed schemas and a future-safe Borg Markdown layer

## Local setup

Use the pinned toolchain from the repo root:

```bash
corepack enable
corepack use pnpm@10.30.3
pnpm install
```

The root package metadata pins `pnpm@10.30.3`, enforces Node `22.x`, provides `.node-version` pinned to `22.22.1` for local version managers, and keeps workspace dependency resolution explicit through `.npmrc`.

For reproducible installs in automation or fresh clones, prefer `pnpm install --frozen-lockfile`.

## Commands

The root scripts are the canonical workspace entrypoints and proxy tasks through Turbo. The current `apps/web` workspace keeps `dev` and `build` executable with placeholders before real app scaffolding lands, `apps/api` provides a runnable Fastify shell, and the current `pnpm test` path exits cleanly when no workspace test tasks are present under Turbo `2.8.14`.

```bash
pnpm dev
pnpm build
pnpm lint
pnpm test
pnpm typecheck
pnpm check
pnpm verify
pnpm --filter @unimatrix/api dev
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

These packages currently expose explicit placeholder `test` scripts so `pnpm test` exercises the workspace contract consistently until LOC-52 adds real package-level test coverage.

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
│   └── content/
├── AGENTS.md
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```
