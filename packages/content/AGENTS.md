# AGENTS.md

## 1. Overview
`packages/content` is the typed content-system boundary for repo-backed authored content. It parses and validates the live public content domains without taking on UI rendering or transport concerns.

## 2. Folder Structure
- `src/collections.ts`: collection metadata and content root constants.
- `src/documents.ts`: document and frontmatter types for home, projects, and blog content.
- `src/frontmatter.ts`: frontmatter parsing helpers.
- `src/parsers.ts`: collection-specific parsing, required-field checks, excerpt derivation, and sorting.
- `src/node.ts`: Node-side file loading for repo-backed content.
- `src/errors.ts`: content-specific error types.
- `src/index.ts`: barrel export for parsing and typing helpers.
- `test`: parser and loader coverage.

## 3. Core Behaviors & Patterns
- **Repo-backed loading**: `src/node.ts` reads markdown files from the live `content/home`, `content/projects`, and `content/blog` directories and returns typed documents. Keep loaders synchronous and filesystem-based unless the package boundary changes intentionally.
- **Typed parsing pipeline**: Parsers split frontmatter extraction, field validation, and document shaping. Required values are enforced through helpers such as `requireString`, `requireDateString`, and `requireBody`.
- **Scope boundary**: This package stays limited to the live public-site domains. Repo-internal docs belong under `docs/`, and future collections such as `content/docs` or `content/notes` stay out of scope until the repo boundary expands.
- **Web registry contract**: `apps/web/src/features/content/site-content.ts` remains an explicit registry for rendered public content. Content changes that add project or blog files must keep that registry in sync.

## 4. Conventions
- **Naming**: Use `parse*` for pure parsing helpers, `load*` for filesystem-backed loaders, and `require*` or `optional*` helpers for frontmatter field extraction.
- **Types**: Keep frontmatter and document types explicit and collection-specific rather than collapsing them into generic record types.
- **Structure**: Put collection-agnostic parsing helpers in `frontmatter.ts` and collection-specific shaping in `parsers.ts`; avoid mixing Node I/O into the pure parser files.

## 5. Working Agreements
- Follow the shared repo working agreements in the root `AGENTS.md`; this file only adds `packages/content` structure, patterns, and conventions.
