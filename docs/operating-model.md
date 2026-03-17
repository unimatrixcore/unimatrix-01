# Operating model

This page defines the current repo boundary for `unimatrix-01`. Use it when
you need to distinguish live surface from reserved future shape, or when you
need the working rules that keep the monorepo coherent.

## Repo purpose

`unimatrix-01` is the active TypeScript monorepo for the Unimatrix public
site, API, shared packages, and Git-backed authored content.

The operating model is current-first.

- Keep the repo runnable today.
- Preserve stable package and app boundaries.
- Document future surface only when it is clearly marked as reserved.
- Keep the root scripts as the canonical workflow surface.

## Live surface

These paths exist now and are part of normal contributor workflow.

- `apps/web`
- `apps/api`
- `packages/ui`
- `packages/shared`
- `packages/api-client`
- `packages/content`
- `packages/db`
- `packages/config-typescript`
- `packages/config-eslint`
- `content/home`
- `content/projects`
- `content/blog`
- `docs/`
- `infra/scripts`
- `infra/deployment`
- `infra/docker`

## Reserved future surface

These paths are part of the intended monorepo direction, but they are not
current live workspaces or content domains.

- `apps/workers`
- `content/docs`
- `content/notes`
- Future packages such as `packages/bmd-parser`
- Future internal tools or operational apps that have not been scaffolded
  yet

When you document or implement work, keep present-tense repo facts separate
from reserved future shape.

## Working rules

These rules keep the monorepo aligned with its current scope.

- Treat the root scripts as the canonical workflow surface for local work and
  CI.
- Keep PRs small and issue-aligned instead of bundling unrelated setup.
- Use one issue branch per scoped piece of work.
- Prefer the Linear-suggested branch name when one exists.
- Use conventional commits.
- Avoid app or package scaffolding unless the issue explicitly asks for it.
- Run relevant validation before review.
- End PR descriptions with `Closes LOC-<issue-key>`.

## V1-ready baseline

For this repo, v1-ready means the following baseline remains true.

- `apps/web` is runnable as the canonical public web workspace.
- `apps/api` is runnable as the canonical API workspace.
- Root scripts are the canonical operating surface for local work and CI.
- The toolchain is pinned to Node `22.22.1` and pnpm `10.30.3`.
- Shared packages are typed and reusable across app boundaries.
- Git-backed typed content exists for `home`, `projects`, and `blog`.
- The deployment and environment contract is documented.
- CI runs against the same root commands contributors use locally.
