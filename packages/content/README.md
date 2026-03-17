# @unimatrix/content

Typed content-system boundary for repo-backed authored content.

This package stays intentionally small and focused on the current public-site domains only:

- `content/home/index.md` for homepage and about copy
- `content/projects/*.md` for projects
- `content/blog/*.md` for blog entries

## Belongs here

- content collection definitions
- frontmatter schemas and validation helpers
- repo-backed content loading utilities

## Does not belong here

- shared API contracts
- transport-specific client code
- UI rendering components

## Current API shape

- collection metadata in `src/collections.ts`
- pure parsing and validation helpers from the package root
- repo-backed Node loaders from `@unimatrix/content/node`

## Required frontmatter

### Home

- `title`
- `intro`
- `summary`
- `mission`

### Projects

- `title`
- `slug`
- `publishedAt`
- `summary`
- `status`
- optional: `repoUrl`, `featured`

### Blog

- `title`
- `slug`
- `publishedAt`
- `summary`
- optional: `description`

All current content files also require a markdown body after the frontmatter block.

## Validation behavior

- invalid or missing fields throw a `ContentValidationError`
- errors include the repo-relative file path and failing field name
- current tests cover both valid parsing and invalid authored content
- excerpt derivation stays plain-text even when authored markdown includes GFM features such as tables, task lists, links, images, and fenced code

## Public v1 scope boundary

- current live public content is limited to `home`, `projects`, and `blog`
- repo-internal operating docs belong under `docs/`, not under `content/`
- operational queue-status posts, policy-page migrations, and future docs or notes collections stay out of scope unless a later issue expands the boundary
- `apps/web/src/features/content/site-content.ts` still uses an explicit raw-import registry
- `apps/web/test/content-registry.test.ts` exists to catch missed project and blog wiring when new content files are added

## Commands

- `pnpm --filter @unimatrix/content lint`
- `pnpm --filter @unimatrix/content typecheck`
- `pnpm --filter @unimatrix/content test`
- `pnpm --filter @unimatrix/content build`

## Deferred work

- docs and notes collections
- raw HTML rendering and executable MDX
- Borg Markdown as a future safe parser and rendering layer

The public site renders authored content with safe GFM, but that renderer belongs in `@unimatrix/ui`, not this package. `@unimatrix/content` continues to own typed contracts, validation, and repo-backed loading only.
