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
- generate migrations: `pnpm --filter @unimatrix/db db:generate`
- apply migrations: `pnpm --filter @unimatrix/db db:migrate`

LOC-40 keeps this package intentionally small so later persistence work can build forward without moving the boundary.