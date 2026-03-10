# @unimatrix/content

Typed content-system boundary for repo-backed authored content.

## Belongs here

- content collection definitions
- frontmatter schemas and validation helpers
- repo-backed content loading utilities

## Does not belong here

- shared API contracts
- transport-specific client code
- UI rendering components

This package is intentionally small in LOC-35 so LOC-43 and later content work can build forward without moving the boundary.
