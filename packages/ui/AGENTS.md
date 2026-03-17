# AGENTS.md

## 1. Overview
`packages/ui` is the shared UI boundary for the monorepo. It hosts the canonical shadcn primitive surface, shared styles, and safe markdown rendering that other workspaces consume.

## 2. Folder Structure
- `src/components/ui`: shared shadcn-based primitives and small supporting components.
- `src/components/public-markdown.tsx`: safe GitHub-flavored markdown rendering for repo-backed content.
- `src/public.ts`: narrowed public-site-safe export surface used by `apps/web`.
- `src/index.ts`: full package barrel for broad shared consumers.
- `src/lib`: shared utilities such as `cn`.
- `src/hooks`: small shared hooks such as `use-mobile`.
- `src/styles.css`: shared design tokens and baseline component styling.
- `test`: Vitest coverage for shared UI behavior.

## 3. Core Behaviors & Patterns
- **Shared primitive surface**: Keep broadly reusable primitives in `src/components/ui/*` and export them through the package barrels. App-specific compositions belong in the consuming app, not here.
- **Two export surfaces**: `src/index.ts` exposes the broader shared package API, while `src/public.ts` exposes a smaller public-safe surface for `apps/web`. Add to `public.ts` only when the export should be safe and stable for the public-site app.
- **Safe markdown rendering**: `PublicMarkdown` sanitizes links, skips raw HTML, applies `remark-gfm`, and renders internal links through an injected callback. Markdown behavior changes should preserve that safe-rendering contract.
- **Shared styling**: `src/styles.css` carries shared tokens and base presentation; consuming apps layer their own styling on top instead of modifying shared styles to fit a single route.

## 4. Conventions
- **File naming**: Component files use kebab-case names such as `alert-dialog.tsx` and `button-group.tsx`, while exported React components stay `PascalCase`.
- **Exports**: Re-export from `src/index.ts` or `src/public.ts` instead of forcing consumers to reach into deep component paths.
- **Scope discipline**: Do not move route loaders, content parsing, or public-site-only layouts into this package unless multiple workspaces need the abstraction.
- **Utilities**: Shared helpers stay small and composable; `cn`-style class merging and other generic helpers belong in `src/lib`, not mixed into component files unless they are component-specific.

## 5. Working Agreements
- Follow the shared repo working agreements in the root `AGENTS.md`; this file only adds `packages/ui` structure, patterns, and conventions.
