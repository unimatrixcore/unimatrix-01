# Operating Model

## Repo purpose

`unimatrix-01/` is the active TypeScript monorepo for the Unimatrix public site, API, shared packages, and repo-backed authored content.

The operating model is current-first:

- keep the repo runnable today
- preserve stable package and app boundaries
- document future surface only when it is clearly marked as reserved
- use the root scripts as the canonical workflow surface

This repo is already beyond a minimal foundation shell. `apps/web` and `apps/api` run today, shared runtime packages have real test entrypoints, and the public v1 content path is live under `content/`.

## Current live surface

These surfaces exist now and are part of normal contributor workflow:

- `apps/web` for the Vite + React public site
- `apps/api` for the Fastify API
- `packages/ui`, `packages/shared`, `packages/api-client`, `packages/content`, and `packages/db` as live typed package boundaries
- `packages/config-typescript` and `packages/config-eslint` as shared config baselines
- `content/home`, `content/projects`, and `content/blog` as the current public authored-content domains
- `docs/` as the canonical repo-internal operating guide
- `infra/scripts`, `infra/deployment`, and `infra/docker` as the current operational support surface

## Reserved future surface

These paths are part of the intended monorepo direction, but they are not current live workspaces or content domains:

- `apps/workers`
- `content/docs`
- `content/notes`
- future packages such as `packages/bmd-parser`
- future internal tools or operational apps that have not been scaffolded yet

When documenting or implementing work, separate present-tense repo facts from reserved future shape.

## Branch and PR workflow

- Use one issue branch per scoped piece of work.
- Prefer the Linear-suggested branch name when available.
- Keep PRs small and issue-aligned instead of bundling unrelated setup.
- Use conventional commits.
- Avoid app or package scaffolding unless the issue explicitly asks for it.
- Run the relevant validation commands before requesting review.
- End PR descriptions with `Closes LOC-<issue-key>`.

## V1-ready means

For this repo, "v1-ready" means the following baseline is true:

- [x] `apps/web` is runnable as the canonical public web workspace.
- [x] `apps/api` is runnable as the canonical API workspace.
- [x] Root scripts are the canonical operating surface for local work and CI.
- [x] The toolchain is pinned to Node `22.22.1` and pnpm `10.30.3`.
- [x] Shared packages are typed and reusable across app boundaries.
- [x] Git-backed typed content exists for `home`, `projects`, and `blog`.
- [x] The deployment and environment contract is documented.
- [x] CI runs against the same root commands contributors use locally.
