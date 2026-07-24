# @unimatrix/shared

Shared cross-app contracts, schemas, and framework-agnostic types for the monorepo.

## Belongs here

- shared API contracts
- shared Zod schemas
- framework-agnostic types reused by multiple apps or packages

## Does not belong here

- transport-specific client code
- content collection loading or frontmatter helpers
- app-specific UI or route code

This package currently ships `defineApiContract` plus the health and per-user-data (`/me/data`, `/me/files`) contracts, all with static paths — add new contracts here rather than redefining shapes in consuming apps.
