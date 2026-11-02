# @unimatrix/content

Typed parsing, validation, and document types for homepage, project, and blog
content. The package owns neither UI rendering nor HTTP transport.

## API

- Collection metadata lives in `src/collections.ts`.
- The package root exports pure parsing and validation helpers.
- `@unimatrix/content/node` exports synchronous filesystem loaders beneath a
  caller-supplied repository root.

Invalid or missing fields throw a `ContentValidationError` containing the file
path and failing field name. Derived excerpts remain plain text when Markdown
includes tables, task lists, links, images, or fenced code.

## Web integration

`apps/web/src/features/content/home.md` holds homepage and About copy, parsed by
`site-content.ts`.
Blog and project entries are managed through `apps/admin`, stored behind the
API, and fetched at runtime. `apps/web/test/content-registry.test.ts` guards
against bundling a second copy of those entries through Markdown imports.
