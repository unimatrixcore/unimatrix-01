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

This package is intentionally minimal in LOC-35 so later work can extend it without changing the package boundary.
