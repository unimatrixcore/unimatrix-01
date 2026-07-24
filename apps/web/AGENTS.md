# AGENTS.md

## 1. Overview
`apps/web` is the Vite + React public site for Unimatrix. It renders repo-backed content through TanStack Router while keeping public-site composition separate from shared UI primitives.

## 2. Folder Structure
- `src/app`: `router.tsx` (router creation), `app-shell.tsx` (shell layout), `auth-boundary.tsx` (Clerk-gated route wrapper), `providers.tsx` (provider wiring).
- `src/features`: feature-local code grouped by concern.
  - `auth`: `require-auth.tsx` guards routes that need a signed-in user, redirecting to the auth app when needed.
  - `content`: registry wiring, markdown helpers, lookup utilities, and lazy markdown loading.
  - `public-site`: app-owned public compositions such as frames, cards, and section headings.
  - `status`: status-route query logic.
- `src/lib`: web-local config (including `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_AUTH_APP_URL`, `VITE_API_BASE_URL` validation), query client setup, and API client wiring.
- `src/routes`: file-based route loaders and lazy route components; keep paired `*.ts(x)` and `*.lazy.tsx` files aligned.
- `src/styles.css`: site-specific presentation layered on top of `@unimatrix/ui/styles.css`.
- `test`: Vitest coverage for routing, content wiring, and markdown behavior.
- `e2e`: Playwright smoke coverage for the public site.

## 3. Core Behaviors & Patterns
- **Route composition**: Each route keeps data loading in the non-lazy file (`index.tsx`, `blog.tsx`, `projects_.$slug.tsx`) and renders UI from the matching lazy file. `routeTree.gen.ts` is generated and should not become a hand-edited source of truth.
- **Shared UI boundary**: App code consumes shared primitives from `@unimatrix/ui/public`, while `src/features/public-site/components.tsx` owns public-site-specific compositions such as `PublicPageContainer`, `PublicSiteFooter`, `PublicSectionHeading`, `PublicDecisionCard`, and `PublicProjectLedgerItem`.
- **Package aliasing**: `vite.config.ts` resolves `@unimatrix/content`, `@unimatrix/shared`, `@unimatrix/auth/react`, and `@unimatrix/ui/public` straight to those packages' source, so they are real build inputs even though only `api-client`, `auth`, and `ui` appear as direct `package.json` dependencies.
- **Auth gating**: `src/app/auth-boundary.tsx` only mounts Clerk's `AuthProvider` (skipped entirely when auth is disabled); `src/features/auth/require-auth.tsx` is the actual signed-in-only route gate (redirect-if-signed-out, render-if-signed-in), not yet applied to any route. Sign-in itself redirects to the separate `apps/auth` hub via `VITE_AUTH_APP_URL`, not an in-app flow.
- **Content loading**: Repo-backed content is imported through the explicit registry in `src/features/content/site-content.ts`. Adding project or blog markdown requires updating that registry so tests and route loaders stay aligned.
- **Safe markdown rendering**: Route components use `LazyPublicMarkdown` plus `renderPublicMarkdownInternalLink` to render authored markdown. Raw HTML and runtime MDX stay disabled; safe GFM rendering lives in `@unimatrix/ui`.
- **Testing split**: Behavior-heavy UI and content rules live under `test/`, while a minimal smoke path for the running site lives under `e2e/public-site.smoke.spec.ts`.

## 4. Conventions
- **Route files**: Use TanStack Router file naming, including underscore and param patterns such as `blog_.$slug.tsx` and `blog_.$slug.lazy.tsx`.
- **Imports**: Group external imports first, then `@/` aliases, then relative imports. App code should prefer `@unimatrix/ui/public` over broad `@unimatrix/ui` imports when it only needs the public-safe surface.
- **Naming**: Components and types use `PascalCase`; public-site composition types and components are prefixed with `Public`. Helpers and config modules use `camelCase` exports from kebab-case or descriptive file names.
- **Styling**: Keep shared tokens and primitives in `@unimatrix/ui/styles.css`; add site-only layout and markdown presentation in `src/styles.css` rather than back-porting public-site presentation into the shared package.

## 5. Working Agreements
- Follow the shared repo working agreements in the root `AGENTS.md`; this file only adds `apps/web` structure, patterns, and conventions.
