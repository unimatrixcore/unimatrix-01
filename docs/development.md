# Development workflow

This page is the canonical local workflow reference for `unimatrix-01`. Use
it for toolchain setup, root commands, env bootstrap behavior, CI alignment,
and database operations.

## Supported toolchain

Use the pinned local toolchain for local work, automation, and CI.

- Node `22.22.1` is pinned in `.node-version`.
- pnpm `10.30.3` is pinned in the root `package.json`
  `packageManager` field.
- `.npmrc` keeps engine checks strict and workspace dependency resolution
  explicit.

## First-run setup

Run the initial setup from the repo root so the workspace resolves
correctly.

1. Run `corepack enable`.
2. Run `corepack use pnpm@10.30.3`.
3. Run `pnpm install`.
4. Optional: Run `pnpm setup:local` if you want app-local `.env` files
   created before you start the dev loop.
5. Run `pnpm dev`.

For a freshly created worktree or other automation, use
`./infra/scripts/pnpm-with-node22.sh setup:worktree` to install workspace
dependencies with a frozen lockfile, bootstrap local env files, and run the
default database migrations in one step.

For reproducible installs in automation or fresh clones, use
`pnpm install --frozen-lockfile`.

## Local entrypoints

The root scripts are the main entry surface for local work.

### `pnpm dev`

Use `pnpm dev` to start the normal local runtime surface.

- Requires Node `22.x`
- Verifies workspace dependencies are already installed
- Creates missing `apps/api/.env` and `apps/web/.env` from their example
  files
- Leaves existing local env files untouched
- Starts only `@unimatrix/api` and `@unimatrix/web` through Turbo
- Does not start `@unimatrix/cube-trainer`; run
  `pnpm --filter @unimatrix/cube-trainer dev` separately. It has no `.env`
  files and no backend dependency.

### `pnpm setup:local`

Use `pnpm setup:local` when you want to bootstrap local env files without
starting the dev servers.

- Copies `apps/api/.env.example` to `apps/api/.env` only when the target is
  missing
- Copies `apps/web/.env.example` to `apps/web/.env` only when the target is
  missing
- Never overwrites an existing local env file

### `pnpm setup:worktree`

Use `pnpm setup:worktree` when a new worktree or fresh automation run needs a
single repo-owned bootstrap command.

- Runs `pnpm install --frozen-lockfile`
- Copies missing `apps/api/.env` and `apps/web/.env` files from their example
  files
- Runs `pnpm db:migrate`
- Warns when `DATABASE_URL` is already set or when multiple worktrees may need
  different local ports
- Accepts `--with-playwright` to install Chromium for `@unimatrix/web` smoke
  tests

## Environment files

The app-local env contract is intentionally narrow and predictable.

- The API startup path loads `apps/api/.env.local` first and then
  `apps/api/.env`.
- Existing shell environment variables still win because the loader does not
  overwrite values already present in `process.env`.
- The web app uses Vite's normal `apps/web/.env*` behavior for `VITE_`
  variables.
- Deployment examples live in `apps/api/.env.production.example` and
  `apps/web/.env.production.example`.

Use [deployment docs](../infra/deployment/README.md) for deployment-specific
environment rules instead of duplicating them here.

## Canonical commands

Use the root commands by default. Drop to a workspace command only when you
are intentionally narrowing scope.

### Root commands

```bash
pnpm dev
pnpm setup:local
pnpm setup:worktree
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
pnpm --filter @unimatrix/cube-trainer dev
pnpm --filter @unimatrix/cube-trainer test:unit
pnpm --filter @unimatrix/cube-trainer test:smoke
pnpm --filter @unimatrix/cube-trainer test
pnpm --filter @unimatrix/content build
pnpm --filter @unimatrix/content test
pnpm --filter @unimatrix/db db:migrate
pnpm --filter @unimatrix/db db:generate
```

## Quality gates

Run the narrowest relevant command set for the change you made.

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm check` as the normal pre-review gate
- `pnpm verify` when the change spans multiple workspaces or affects the
  runtime surface

## CI behavior

GitHub Actions CI stays aligned to the same root command surface used
locally.

- Checks out the repo without persisted credentials
- Sets up pnpm `10.30.3`
- Reads Node from `.node-version`
- Runs `pnpm install --frozen-lockfile`
- Installs Playwright Chromium for `@unimatrix/web` and `@unimatrix/cube-trainer`
- Runs `pnpm build`
- Runs `pnpm lint`
- Runs `pnpm typecheck`
- Runs `pnpm test`

Keep ad-hoc browser screenshots and other debug artifacts in ignored
`.issues/` scratch space, or leave them uncommitted instead of placing them
in the repo root.

## Database workflow

The database package stays SQLite-first unless a later issue changes that
decision.

- Default SQLite file: `packages/db/local/unimatrix.sqlite`
- Root migration alias: `pnpm db:migrate`
- Root migration generation alias: `pnpm db:generate`
- Supported override: `DATABASE_URL`

When `DATABASE_URL` is unset, the db package uses the default SQLite path.
When it is set, the current code accepts absolute paths, repo-relative paths,
`file:` URLs, and `:memory:`.

## Unsupported host runtimes

Use the checked-in wrapper when the host does not already have compatible
local Node and pnpm versions active.

```bash
./infra/scripts/pnpm-with-node22.sh install --frozen-lockfile
./infra/scripts/pnpm-with-node22.sh setup:worktree
./infra/scripts/pnpm-with-node22.sh check
./infra/scripts/pnpm-with-node22.sh verify
```

When the host already matches Node `22.x` and pnpm `10.30.3`, the wrapper
takes a fast path and reuses them. Otherwise it bootstraps `node@22.22.1`
and `pnpm@10.30.3` through `npm exec`.
