# AGENTS.md

You are working inside `unimatrix-01/`, the active Unimatrix monorepo.

This file is the machine and agent contract. Canonical human operating docs live under [docs/](docs/README.md).

## Purpose

Build and maintain a TypeScript monorepo that supports:

- the public-facing site
- the API
- shared UI, schema, content, and client packages
- Git-backed authored content
- future internal tools and additional runtime surfaces when they are explicitly added

Optimize for long-term maintainability, coherent package boundaries, and current repo reality instead of speculative scaffolding.

## Current live surface

These surfaces exist now and are safe to treat as part of normal repo operations:

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

Reserved but not present as live surfaces yet:

- `apps/workers`
- `content/docs`
- `content/notes`
- future packages such as `packages/bmd-parser`

Do not describe reserved paths as current runtime or content surfaces.

## Toolchain and commands

- Supported Node version: `22.22.1` from `.node-version`
- Supported pnpm version: `10.30.3` from the root `package.json`
- `.npmrc` keeps engines strict and workspace resolution explicit

Use these root commands as the canonical operating surface:

```bash
pnpm install
pnpm setup:local
pnpm dev
pnpm build
pnpm lint
pnpm test
pnpm typecheck
pnpm check
pnpm verify
pnpm db:migrate
pnpm db:generate
pnpm --filter @unimatrix/web dev
pnpm --filter @unimatrix/api dev
```

If the host runtime is not already on local Node `22.x` and pnpm `10.30.3`, use the wrapper:

```bash
./infra/scripts/pnpm-with-node22.sh install --frozen-lockfile
./infra/scripts/pnpm-with-node22.sh check
./infra/scripts/pnpm-with-node22.sh verify
```

## Local development behavior

- `pnpm dev` requires Node `22.x`, checks that dependencies are installed, bootstraps missing `apps/api/.env` and `apps/web/.env` from their example files, then runs only `@unimatrix/api` and `@unimatrix/web` through Turbo.
- `pnpm setup:local` bootstraps those same app-local `.env` files without starting the dev servers.
- Existing `apps/api/.env` and `apps/web/.env` files are never overwritten by either command.
- API startup loads `apps/api/.env.local` first and then `apps/api/.env`; shell environment variables still win.
- The web app uses Vite's normal `apps/web/.env*` loading behavior for `VITE_` variables.

## Default stack

Unless explicitly told otherwise, use these defaults.

### Monorepo

- `pnpm` workspaces
- Turborepo
- `apps/` and `packages/` structure

### Frontend

- Vite
- React
- TypeScript
- TanStack Router
- TanStack Query
- Zustand
- Zod
- React Hook Form
- ShadCN UI
- Tailwind CSS v4
- `shadcn-ux-designer` workflow
- ShadCN preset `aJMzyTw`
- Geist Mono
- zero-radius styling
- Remix Icons
- ADHD-accessible design constraints
- desktop-first UX bias

### Backend

- Fastify
- TypeScript
- Zod validation
- Pino logging
- Drizzle ORM
- SQLite first
- clear migration path to Postgres
- Redis only when it solves a real need

### Content

- Git-based content inside the repo
- typed frontmatter and content schemas
- safe authored-markdown rendering for the public site
- Borg Markdown as a separate future parser/rendering layer

## Workflow guidance

### Branch and PR workflow

- use one issue branch per scoped piece of work
- prefer the Linear-suggested branch name when available
- keep PRs small and issue-aligned rather than bundling unrelated setup work
- use conventional commits
- avoid app or package scaffolding unless the issue explicitly asks for it
- run relevant validation before requesting review
- end PR descriptions with `Closes LOC-<issue-key>`

### AGENTS strategy

- the nearest `AGENTS.md` always wins
- this file is the repo-wide default for `unimatrix-01/`
- add deeper `AGENTS.md` files only when a subtree gains stable local conventions that should override this repo-wide guidance

## Architecture rules

### Frontend

- use ShadCN UI as the component foundation
- follow the `shadcn-ux-designer` workflow for frontend design and implementation decisions
- use the ShadCN preset `aJMzyTw` unless explicitly instructed otherwise
- preserve the intended frontend identity: Geist Mono typography, zero-radius styling, and Remix Icons
- design with ADHD-accessible constraints in mind: clear hierarchy, limited cognitive load, progressive disclosure, and calm interfaces
- bias layouts and interaction patterns desktop-first unless a task explicitly prioritizes mobile
- prefer feature-based organization
- keep server state in TanStack Query
- keep shared UI state in Zustand only when truly necessary
- validate inputs and external data with Zod
- favor route-level code splitting and explicit content schemas

### Backend

- organize by domain
- keep handlers thin
- put business logic in service modules
- validate every external input boundary
- use structured logging
- separate transport, validation, and domain logic cleanly

### Packages

- shared logic belongs in packages only when it is truly shared or clearly becoming shared
- avoid copy-paste across apps
- favor stable package boundaries over giant catch-all utility folders

### Content

- treat content as a first-class system
- validate frontmatter and collection schemas
- keep authored content Git-based
- current live public content domains are `home`, `projects`, and `blog`
- `content/docs` and `content/notes` remain reserved, not present
- when adding new `content/projects/*.md` or `content/blog/*.md` files, also update `apps/web/src/features/content/site-content.ts`
- `apps/web/test/content-registry.test.ts` exists to catch missed project and blog registry updates
- never execute untrusted generated content as code
- Borg Markdown must parse only into a safe whitelist of supported structures and components

## Code style

- TypeScript by default
- strict typing preferred
- named exports preferred over default exports
- keep modules small and composable
- avoid deep relative import chains when package boundaries are the right abstraction

## Testing

At minimum, changed code should pass:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Preferred testing shape:

- unit tests for utilities and parsers
- component tests for UI behavior
- integration tests for API routes
- end-to-end tests for critical flows

If a package does not yet implement one of these commands, call that out clearly.

## Boundaries

### Always

- optimize for long-term maintainability
- keep architecture consistent with the monorepo direction
- use ShadCN rather than reviving Borg UI
- follow the `shadcn-ux-designer` workflow for frontend work
- use preset `aJMzyTw` unless explicitly told otherwise
- preserve the intended frontend system: Geist Mono, zero-radius styling, Remix Icons, ADHD-accessible UX, and desktop-first bias
- preserve Borg Markdown as a future-safe concept
- prefer typed contracts and explicit schemas

### Ask first

- switching away from Vite, Fastify, pnpm, or Turborepo
- moving from SQLite to Postgres before the need is real
- introducing a headless CMS instead of Git-based content
- making major package boundary changes

### Never

- build this as if it were only a static portfolio refresh
- execute untrusted markdown, MDX, or arbitrary generated code
- hardcode secrets or commit credentials
- collapse everything back into isolated app silos by default

## Definition of good work

Good work in `unimatrix-01/` makes the monorepo more coherent, typed, package-aware, content-aware, and ready for future projects to plug into without architectural chaos.
