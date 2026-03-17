# @unimatrix/ui

Shared ShadCN-based UI primitives for the Unimatrix monorepo.

## Belongs here

- the canonical shadcn package for the repo
- the full built-in shadcn component surface generated into `src/components/ui`
- shared primitives and helpers such as `cn`
- shared styling exported as `@unimatrix/ui/styles.css`
- cross-app rendering primitives that are still genuinely shared, such as `PublicMarkdown`

## Does not belong here

- route loaders or content parsing logic
- public-site-specific compositions for `apps/web`
- dashboard/admin-specific compositions
- speculative app-specific abstractions without a clear cross-app caller

## Current model

- `PublicMarkdown`
- `src/components/ui/*` is the built-in shadcn surface for shared primitives
- `apps/web` owns public-site compositions such as frames, section headings, cards, and route-specific layout pieces
- `apps/web/src/styles.css` layers site-specific presentation on top of `@unimatrix/ui/styles.css`

`PublicMarkdown` provides safe GitHub-flavored markdown rendering for authored content. Raw HTML and executable MDX remain out of scope, and Borg Markdown remains future parser work rather than part of this package.

## Commands

- `pnpm --filter @unimatrix/ui lint`
- `pnpm --filter @unimatrix/ui typecheck`
- `pnpm --filter @unimatrix/ui build`
- `pnpm --filter @unimatrix/ui test`
