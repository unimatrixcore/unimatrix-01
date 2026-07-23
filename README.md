# Unimatrix-01

Unimatrix-01 is the active TypeScript monorepo for the public site, API,
shared packages, and Git-backed content.

## Quick start

Use the pinned toolchain from `.node-version` and the root
`packageManager` field when you work locally.

1. Run `corepack enable`.
2. Run `corepack use pnpm@10.30.3`.
3. Run `pnpm install`.
4. Optional: Run `pnpm setup:local` if you want app-local `.env` files
   created before the dev loop starts.
5. Run `pnpm dev`.

For a freshly created worktree or other automation, you can replace the
manual bootstrap steps with `./infra/scripts/pnpm-with-node22.sh
setup:worktree`. That command installs workspace dependencies with a frozen
lockfile, bootstraps local env files, and runs database migrations.

If your host runtime does not already match the pinned Node and pnpm
versions, use `./infra/scripts/pnpm-with-node22.sh install
--frozen-lockfile` and `./infra/scripts/pnpm-with-node22.sh dev`.

## What lives here

This repo keeps the current runtime surface narrow and explicit.

- `apps/web` contains the Vite + React public site.
- `apps/api` contains the Fastify API.
- `apps/cube-trainer` contains the Vite + React OLL/PLL algorithm trainer
  (no backend dependency).
- `apps/auth` contains the Vite + React accounts app: the central
  Clerk-backed authentication hub for sign-in/sign-up and account management
  (user/permission management is handled in the Clerk Dashboard).
- `packages/` contains shared UI, content, database, config, contract, auth,
  and user-data packages.
- `content/` contains the public authored content rendered by the web app.

## Docs

Use the short index below to jump to the right source of truth.

- Human operating guide: [docs/README.md](docs/README.md)
- Deployment contract: [infra/deployment/README.md](infra/deployment/README.md)
- Local container posture: [infra/docker/README.md](infra/docker/README.md)
- Agent contract: [AGENTS.md](AGENTS.md)
