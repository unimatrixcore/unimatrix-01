# AGENTS.md

## 1. Overview
`packages/content` provides typed authored-content parsing and filesystem loaders without taking on UI rendering or transport concerns.

## 2. Core Behaviors & Patterns
- **Filesystem loading**: `src/node.ts` reads Markdown collections beneath the supplied root directory and returns typed documents. Keep loaders synchronous and filesystem-based unless the package boundary changes intentionally.
- **Typed parsing pipeline**: Parsers split frontmatter extraction, field validation, and document shaping. Required values are enforced through helpers such as `requireString`, `requireDateString`, and `requireBody`.
- **Scope boundary**: This package stays limited to the live public-site domains.

## 3. Conventions
- **Naming**: Use `parse*` for pure parsing helpers, `load*` for filesystem-backed loaders, and `require*` or `optional*` helpers for frontmatter field extraction.
- **Types**: Keep frontmatter and document types explicit and collection-specific rather than collapsing them into generic record types.
- **Structure**: Put collection-agnostic parsing helpers in `frontmatter.ts` and collection-specific shaping in `parsers.ts`; avoid mixing Node I/O into the pure parser files.

