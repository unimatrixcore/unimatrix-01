# Development Workflow

## Supported toolchain

- Node `22.22.1` is the supported runtime and is pinned in `.node-version`.
- pnpm `10.30.3` is the supported package manager and is pinned in the root `package.json` `packageManager` field.
- `.npmrc` keeps engine checks strict and workspace dependency resolution explicit.

Use the pinned toolchain for local work, automation, and CI.

## First-run setup

From the repo root:

```bash
corepack enable
corepack use pnpm@10.30.3
pnpm install
pnpm dev
```

For reproducible installs in automation or fresh clones, prefer:

```bash
pnpm install --frozen-lockfile
```

## Local dev entrypoints

### `pnpm dev`

`pnpm dev` is the canonical local-entry command. It does all of the following before starting the app processes:

- requires Node `22.x`
- verifies workspace dependencies are already installed
- creates missing `apps/api/.env` and `apps/web/.env` from their example files
- leaves existing local env files untouched
- starts only `@unimatrix/api` and `@unimatrix/web` through Turbo

### `pnpm setup:local`

Use `pnpm setup:local` when you only want to bootstrap local env files without starting the dev servers. It creates missing files from:

- `apps/api/.env.example`
- `apps/web/.env.example`

Existing local env files are never overwritten.

## Environment bootstrap behavior

- The API startup entrypoint loads `apps/api/.env.local` first and then `apps/api/.env` when those files exist.
- Exported shell environment variables still win, because the API loader does not overwrite values already present in `process.env`.
- The web app uses Vite's standard `apps/web/.env*` loading behavior for `VITE_` variables.
- Deployment-oriented examples live in `apps/api/.env.production.example` and `apps/web/.env.production.example`.

Use [infra/deployment/README.md](../infra/deployment/README.md) for deployment-specific environment rules instead of duplicating that contract into repo-operating docs.

## Canonical commands

### Root commands

```bash
pnpm dev
pnpm setup:local
pnpm build
pnpm lint
pnpm test
pnpm typecheck
pnpm check
pnpm verify
pnpm db:migrate
pnpm db:generate
```

### Workspace commands

```bash
pnpm --filter @unimatrix/web dev
pnpm --filter @unimatrix/web test:unit
pnpm --filter @unimatrix/web test:smoke
pnpm --filter @unimatrix/web test
pnpm --filter @unimatrix/api dev
pnpm --filter @unimatrix/api test
pnpm --filter @unimatrix/content build
pnpm --filter @unimatrix/content test
pnpm --filter @unimatrix/db db:migrate
pnpm --filter @unimatrix/db db:generate
```

Prefer the root scripts unless you are intentionally working inside one workspace.

## Quality gates

The canonical quality gates are:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm check` for the default pre-review gate
- `pnpm verify` for the fuller local release gate that also includes `build`

Run the narrowest relevant command set for scoped work, and use `pnpm verify` before review when the change spans multiple workspaces or affects the runtime surface.

## CI behavior

GitHub Actions CI runs on branch pushes and stays aligned to the root command surface:

- checks out the repo without persisted credentials
- sets up pnpm `10.30.3`
- reads Node from `.node-version`
- runs `pnpm install --frozen-lockfile`
- installs Playwright Chromium for `@unimatrix/web`
- runs `pnpm build`
- runs `pnpm lint`
- runs `pnpm typecheck`
- runs `pnpm test`

This keeps CI aligned with local contributor workflows instead of introducing a separate automation-only command surface.

Keep ad-hoc browser screenshots and other debug artifacts in ignored `.issues/` scratch space, or leave them uncommitted instead of placing them in the repo root.

## Database workflow

- Default SQLite file: `packages/db/local/unimatrix.sqlite`
- Root migration alias: `pnpm db:migrate`
- Root migration generation alias: `pnpm db:generate`
- Supported override: `DATABASE_URL`

When `DATABASE_URL` is unset, the db package uses the default SQLite path above. When it is set, the current code accepts absolute paths, repo-relative paths, `file:` URLs, and `:memory:`.

## Unsupported host runtimes

If the host is not already running local Node `22.x` and pnpm `10.30.3`, use the checked-in wrapper:

```bash
./infra/scripts/pnpm-with-node22.sh install --frozen-lockfile
./infra/scripts/pnpm-with-node22.sh check
./infra/scripts/pnpm-with-node22.sh verify
```

When the host already has compatible local Node and pnpm versions active, the wrapper takes a fast path and reuses them. Otherwise it bootstraps `node@22.22.1` and `pnpm@10.30.3` through `npm exec`.

For deployment docs and the current local-container posture, use:

- [infra/deployment/README.md](../infra/deployment/README.md)
- [infra/docker/README.md](../infra/docker/README.md)
