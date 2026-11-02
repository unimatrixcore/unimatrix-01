# Unimatrix-01

Unimatrix-01 is the TypeScript monorepo for the public site, API, tools, and
shared packages.

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
manual bootstrap steps with `./infra/scripts/pnpm-with-pinned-node.sh
setup:worktree`. That command installs workspace dependencies with a frozen
lockfile, bootstraps local env files, and runs database migrations.

If your host runtime does not already match the pinned Node and pnpm
versions, use `./infra/scripts/pnpm-with-pinned-node.sh install
--frozen-lockfile` and `./infra/scripts/pnpm-with-pinned-node.sh dev`.

## What lives here

The workspace roster is `pnpm-workspace.yaml`; `AGENTS.md` carries the
per-package boundaries.

Homepage and About copy ships with `apps/web`; blog and project entries are
managed through `apps/admin` and fetched from the API at runtime.

## Docs

- Operating model: [docs/operating-model.md](docs/operating-model.md)
- Development workflow: [docs/development.md](docs/development.md)
- Content workflow: [docs/content.md](docs/content.md)
- Deployment contract: [docs/deployment.md](docs/deployment.md)
- Local container posture: [infra/docker/README.md](infra/docker/README.md)
- Agent contract: [AGENTS.md](AGENTS.md)
