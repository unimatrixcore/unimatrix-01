# AGENTS.md

## 1. Overview
`apps/web` is the Vite + React public site for Unimatrix. It is fully anonymous — no Clerk, no sign-in affordance, no account-scoped UI. Blog and project content is fetched from the API at runtime; homepage and About copy ships in the app source. Public-site composition stays separate from shared UI primitives. Blog and project content is managed from `apps/admin`, not here: `/admin` and `/admin/*` are redirect-only routes pointing at that origin, and this app holds no editing surface and no authenticated API client.

## 2. Folder Structure
- `src/app`: `router.tsx` (router creation), `app-shell.tsx` (shell layout), `providers.tsx` (provider wiring).
- `src/features`: feature-local code grouped by concern.
  - `content`: registry wiring, markdown helpers, lookup utilities, and lazy markdown loading.
  - `public-site`: app-owned public compositions such as frames, cards, and section headings.
  - `status`: the unrouted reference example for fetching `GET /health` through `@unimatrix/api-client`.
- `src/lib`: web-local config (`VITE_API_BASE_URL` validation and the dev-proxy target), query client setup, and API client wiring.
- `src/routes`: file-based route loaders and lazy route components; keep paired `*.ts(x)` and `*.lazy.tsx` files aligned.
- `src/styles.css`: site-specific presentation layered on top of `@unimatrix/ui/styles.css`.
- `test`: Vitest coverage for routing, content wiring, and markdown behavior.
- `e2e`: Playwright coverage that needs a real browser — the public-site smoke path and the layout/observer regressions.

## 3. Core Behaviors & Patterns
- **Route composition**: Each route keeps data loading in the non-lazy file (`index.tsx`, `blog.tsx`, `projects_.$slug.tsx`) and renders UI from the matching lazy file. `routeTree.gen.ts` is generated and should not become a hand-edited source of truth.
- **Shared UI boundary**: App code consumes shared primitives from `@unimatrix/ui/public`, while `src/features/public-site/components.tsx` owns public-site-specific compositions such as `PublicSectionHeading`, `PublicDecisionCard`, and `PublicProjectLedgerItem`.
- **Package aliasing**: `vite.config.ts` aliases workspace imports to package source, so they are real build inputs — `resolve.alias` there is the list.
- **Admin redirect**: `src/routes/admin.tsx` and `src/routes/admin.$.tsx` each throw a full-document `redirect` to `https://admin.unimatrix-01.dev/` in `beforeLoad`, so an old `/admin` link still lands somewhere. They hold no UI and deliberately drop the query string, since the admin route paths differ from the ones a stale link carries. `admin.tsx` is the parent layout of `admin.$.tsx`, so its `beforeLoad` already covers every `/admin/*` match; the second file is belt-and-braces.
- **Content loading**: Blog and project entries are fetched at runtime from the API (`src/features/content/queries`). Edit homepage and About copy in `src/features/content/home.md`; `site-content.ts` parses it into the bundle so it remains available when the API is unreachable.
- **Safe markdown rendering**: Route components use `LazyPublicMarkdown` plus `renderPublicMarkdownInternalLink` to render authored markdown. Raw HTML and runtime MDX stay disabled; safe GFM rendering lives in `@unimatrix/ui`.
- **Testing split**: Behavior-heavy UI and content rules live under `test/`, while the browser-only checks — the smoke path plus the layout and `ResizeObserver` regressions no jsdom test can catch — live under `e2e/`.

## 4. Conventions
- **Route files**: Use TanStack Router file naming, including underscore and param patterns such as `blog_.$slug.tsx` and `blog_.$slug.lazy.tsx`.
- **Imports**: Group external imports first, then `@/` aliases, then relative imports. App code should prefer `@unimatrix/ui/public` over broad `@unimatrix/ui` imports when it only needs the public-safe surface.
- **Naming**: Components and types use `PascalCase`; public-site composition types and components are prefixed with `Public`. Helpers and config modules use `camelCase` exports from kebab-case or descriptive file names.
- **Styling**: Keep shared tokens and primitives in `@unimatrix/ui/styles.css`; add site-only layout and markdown presentation in `src/styles.css` rather than back-porting public-site presentation into the shared package.

