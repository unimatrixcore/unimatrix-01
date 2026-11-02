# Development workflow

This page is the canonical local workflow reference for `unimatrix-01`. Use
it for toolchain setup, root commands, env bootstrap behavior, CI alignment,
and database operations.

## Supported toolchain

Use the pinned local toolchain for local work, automation, and CI.

- Node `24.18.0` is pinned in `.node-version`.
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
`./infra/scripts/pnpm-with-pinned-node.sh setup:worktree` to install workspace
dependencies with a frozen lockfile, bootstrap local env files, and run the
default database migrations in one step.

For reproducible installs in automation or fresh clones, use
`pnpm install --frozen-lockfile`.

## Local entrypoints

The root scripts are the main entry surface for local work.

### `pnpm dev`

Use `pnpm dev` to start the normal local runtime surface.

- Requires the Node major pinned in `.node-version`; exits non-zero on any other
- Verifies workspace dependencies are already installed
- Creates missing `apps/api/.env` and `apps/web/.env` from their example
  files
- Leaves existing local env files untouched
- Starts only `@unimatrix/api` and `@unimatrix/web` through Turbo
- Starts no other app; root `AGENTS.md`'s "Runtime And Bootstrap" section
  lists how each of the others is started and what env it needs.

Every app pins its own dev and preview port in its `vite.config.ts`, with
`strictPort: true` — a port already in use refuses to start rather than moving
to the next free one, so an app always answers on the port the API's CORS
allowlist and the Playwright smoke config expect.

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
  variables. `apps/auth` follows the same Vite `.env*` behavior.
- Deployment examples live in `apps/api/.env.production.example` and
  `apps/web/.env.production.example`.
- The API's Clerk auth env (`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`,
  `CLERK_JWT_KEY`) is optional in development and test: the API boots with
  auth disabled when they are unset, and is required only in production.

Use [deployment docs](./deployment.md) for deployment-specific
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

`pnpm --filter <package> <script>` runs one workspace's script; each
workspace's `package.json` is the list. Root `AGENTS.md` carries the
file-scoped and per-workspace commands worth memorising.

## Quality gates

Run the narrowest relevant command set for the change you made.

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm check` as the normal pre-review gate
- `pnpm verify` when the change spans multiple workspaces or affects the
  runtime surface

## CI behavior

CI runs most of the root gates individually rather than through
`pnpm check`/`pnpm verify`, and runs gates neither wrapper has — shellcheck
and the Lighthouse budgets among them; it also omits some the wrappers run.
A separate `Images` job builds every
`apps/*/Dockerfile`; those checks are required on `main`, and `Verify` never
touches a Dockerfile. `.github/workflows/ci.yml` is the authority on the exact
step list.

On pull requests, `infra/scripts/ci-plan.mjs` selects changed workspaces and
their transitive consumers from package manifests. Repository-wide guards still
run. Unknown paths, toolchain changes, and unavailable comparison history select
every workspace; guidance-only changes outside workspaces can select none.
Pushes to `main` and manual runs select every workspace. Browser setup and
Lighthouse follow the selected apps, while image checks remain unconditional.

Build, lint, and typecheck results can reuse Turbo's cache. Tests run fresh, as
does the TV plugin build whose output depends on the host .NET SDK. Successful
`main` runs save a bounded task-cache archive; PRs only restore it. The workflow
uses standard GitHub-hosted runners and does not raise cache storage limits.

To inspect a PR selection locally, supply its complete base and head commit SHAs:

```bash
node infra/scripts/ci-plan.mjs --event pull_request --base <base-sha> --head <head-sha> --output /tmp/ci-plan.json
node infra/scripts/ci-plan.mjs run test --plan /tmp/ci-plan.json
node infra/scripts/check-coverage-drift.mjs --plan /tmp/ci-plan.json
```

Build selected workspaces before tests that preview an app. Coverage drift
requires a summary for every selected workspace declaring Vitest thresholds;
Node-test-only or explicitly empty selections require no Vitest summary.
`pnpm check:ci` exercises selection, coverage failure cases, and cache invalidation.

Keep ad-hoc browser screenshots and other debug artifacts in ignored
`.notes/` scratch space, or leave them uncommitted instead of placing them
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
./infra/scripts/pnpm-with-pinned-node.sh install --frozen-lockfile
./infra/scripts/pnpm-with-pinned-node.sh setup:worktree
./infra/scripts/pnpm-with-pinned-node.sh check
./infra/scripts/pnpm-with-pinned-node.sh verify
```

When the host already matches the pins in `.node-version` and `packageManager`,
the wrapper takes a fast path and reuses them. Otherwise it bootstraps both
through `npm exec`.
