# AGENTS.md

You are working inside `unimatrix-01/`, the active Unimatrix-01 monorepo.

This directory is the real future system. It is not a temporary comparison space and it is not just a redesign of the Hugo site.

When this repo is checked out beside `unimatrix-01-legacy/`, treat the legacy repo as reference material only. Use it for migration context, content domains, and design instincts, but do not treat Hugo-era implementation details as the target architecture.

## Purpose

Build a TypeScript monorepo foundation that can support:

- the public-facing everything-site
- projects, blog, docs, and notes
- shared UI, schemas, content tooling, and client packages
- future internal tools and operational apps
- experimental systems that belong in the same ecosystem

The design goal is long-term extensibility, coherence, and reuse.

## Default Stack

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
- MDX or typed markdown collections for authored content
- Borg Markdown as a separate safe parser and rendering layer for dynamic interactive responses

## Target Shape

```text
unimatrix-01/
  apps/
    web/
    api/
    workers/
  packages/
    ui/
    shared/
    content/
    api-client/
    bmd-parser/
    config-eslint/
    config-typescript/
  content/
    blog/
    projects/
    docs/
    notes/
  infra/
    docker/
    scripts/
    github/
```

Not every directory must exist immediately, but new work should move toward this shape.

## Commands

Use these as the standard targets for new work:

```bash
pnpm install
pnpm dev
pnpm build
pnpm lint
pnpm test
pnpm typecheck
pnpm --filter web dev
pnpm --filter api dev
turbo run build
turbo run lint
turbo run test
```

## Branch and PR Workflow

- use one issue branch per scoped piece of work
- prefer the Linear-suggested branch name when available
- keep PRs small and issue-aligned rather than bundling unrelated setup work
- use conventional commits
- run relevant validation before requesting review
- end PR descriptions with `Closes LOC-<issue-key>`

## AGENTS Strategy

- the nearest `AGENTS.md` always wins
- this file is the repo-wide default for `unimatrix-01/`
- if a workspace-root `../AGENTS.md` exists, it governs cross-repo behavior when work touches the legacy repo too
- add deeper `AGENTS.md` files only when a subtree gains stable local conventions that should override this repo-wide guidance

## Architecture Rules

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
- never execute untrusted generated content as code
- Borg Markdown must parse only into a safe whitelist of supported structures and components

## Code Style

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
- execute untrusted MDX or arbitrary LLM-generated code
- hardcode secrets or commit credentials
- collapse everything back into isolated app silos by default

## Definition of Good Work

Good work in `unimatrix-01/` makes the monorepo more coherent, typed, package-aware, content-aware, and ready for future projects to plug into without architectural chaos.
