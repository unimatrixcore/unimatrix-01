# @unimatrix/content

Typed content-system boundary for repo-backed authored content.

LOC-43 keeps this package intentionally small and focused on the first public-site domains only:

- `content/home/index.md` for homepage/about copy
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

## Commands

- `pnpm --filter @unimatrix/content lint`
- `pnpm --filter @unimatrix/content typecheck`
- `pnpm --filter @unimatrix/content test`
- `pnpm --filter @unimatrix/content build`

## Deferred work

- docs and notes collections
- detail-page routing and richer rendering
- Borg Markdown as a future safe parser/rendering layer
