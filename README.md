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

This repo currently includes only the root monorepo foundation:

- `apps/`
- `packages/`
- `content/`
- `infra/`
- `pnpm-workspace.yaml`
- `turbo.json`
- minimal root package metadata

No apps or packages are scaffolded yet on purpose.

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

## Commands

The root scripts are intentionally lightweight placeholders until the first real workspace packages are added.

```bash
pnpm dev
pnpm build
pnpm lint
pnpm test
pnpm typecheck
```

## Repository shape

```text
.
├── apps/
├── content/
├── infra/
├── packages/
├── AGENTS.md
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```
