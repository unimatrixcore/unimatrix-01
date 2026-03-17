# @unimatrix/ui

Shared ShadCN-based UI primitives for the Unimatrix monorepo.

## Belongs here

- low-level shared primitives like `Button`, `Badge`, `Card`, and `Separator`
- the intentionally small composed public-site surface used by `apps/web`

## Does not belong here

- route loaders or content parsing logic
- dashboard/admin-specific components
- speculative app-specific abstractions without an in-repo caller

## Current public-site surface

- `PublicPageContainer`
- `PublicAppFrame`
- `PublicMarkdown`
- `PublicSectionHeading`
- `PublicContentParagraphs`
- `PublicProjectCard`
- `PublicPostListItem`

LOC-46 keeps this surface narrow on purpose: it should cover the lightweight public site that already exists without turning `@unimatrix/ui` into a broad application component library.

`PublicMarkdown` now provides safe GitHub-flavored markdown rendering for authored public-site content. Raw HTML and executable MDX remain out of scope, and Borg Markdown remains future parser work rather than part of this package.

## Commands

- `pnpm --filter @unimatrix/ui lint`
- `pnpm --filter @unimatrix/ui typecheck`
- `pnpm --filter @unimatrix/ui build`
- `pnpm --filter @unimatrix/ui test`
