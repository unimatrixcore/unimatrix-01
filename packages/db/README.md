# @unimatrix/db

Minimal persistence boundary for the Unimatrix monorepo.

## Belongs here

- Drizzle ORM configuration
- SQLite connection and migration helpers
- baseline schema definitions that future platform work can extend

## Does not belong here

- API route handlers
- product-specific domain modeling beyond issue scope
- transport or UI concerns

## Local workflow

- default SQLite file: `packages/db/local/unimatrix.sqlite`
- root migration alias: `pnpm db:migrate`
- root migration generation alias: `pnpm db:generate`
- generate migrations: `pnpm --filter @unimatrix/db db:generate`
- apply migrations: `pnpm --filter @unimatrix/db db:migrate`
- `DATABASE_URL` override forms:
- absolute filesystem path
- repo-relative filesystem path
- `file:` URL
- `:memory:`

LOC-40 keeps this package intentionally small so later persistence work can build forward without moving the boundary.
