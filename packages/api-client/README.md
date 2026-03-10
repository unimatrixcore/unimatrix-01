# @unimatrix/api-client

Typed transport boundary for API client code in the monorepo.

## Belongs here

- client configuration
- request helpers and transport abstractions
- typed client utilities that consume contracts from `@unimatrix/shared`

## Does not belong here

- canonical schemas or shared contract definitions
- server-only route logic
- content loading concerns

LOC-35 keeps this package intentionally minimal so LOC-41 can add real contract-aware client behavior without restructuring.
