# Unimatrix-01

Unimatrix-01 is the future TypeScript monorepo for the broader Unimatrix ecosystem.

This repository is intentionally starting from a **minimal foundation state** so it can receive a clean first commit and first push without accidental app scaffolding or premature complexity.

## Purpose

- host the public-facing site
- support projects, blog, docs, and notes
- provide room for shared UI, schemas, content tooling, and client packages
- preserve long-term monorepo boundaries from day one

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