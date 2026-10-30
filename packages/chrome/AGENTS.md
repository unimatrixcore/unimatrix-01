# AGENTS.md

## 1. Overview
`packages/chrome` owns the two shared application shells: `./tool` (desktop-app chrome for tools, dashboards, and admin surfaces) and `./public` (site header, nav tabs, breadcrumbs, site footer). Every service gets its chrome by importing one of the two rather than growing an app-local shell.

## 2. Folder Structure
- `src/tool-shell.tsx`: the tool shell — title bar, dense content region, no site nav tabs and no site footer.
- `src/`: the public-site shell pieces — `PublicShell`, `PublicPageContainer`, `PublicFooterLink`, and the header, nav tabs, breadcrumbs and footer they compose.

## 3. Core Behaviors & Patterns
- Composes `@unimatrix/ui` for its own UI, and **never `@unimatrix/auth`.** That prohibition is
  the load-bearing one. It is not a claim of zero dependencies: `@tanstack/react-router`, `react`
  and `react-dom` are declared **peers** and are supplied by the consuming app (see §5 for why
  the router in particular must not resolve twice). Both shells take the account control as a `ReactNode` slot, which is what lets a sign-in-free tool like `apps/cflop` import a shell without pulling Clerk into its dependency tree.
- Route knowledge — nav items, breadcrumb trails, sign-in hrefs — is passed in by the app, never computed here.
- `./tool`'s `ToolShell` has two layouts. Supplying a non-empty `sections` moves the wordmark and `accountControl` into a collapsible section rail and removes the title bar; the footer strip renders below the content in both layouts unless `showFooter={false}` omits it — the `contentinfo` landmark count matches between the two layouts for a given `showFooter` value, but is not fixed at one; omitting `sections` (or passing an empty array) keeps today's title-bar-plus-footer layout.

- `ToolShell scroll="section"` bounds the frame to the viewport and reserves title/footer space. Its children must carry `flex-1 min-h-0` and own pane scrolling; page mode keeps document scrolling and the no-rail centered layout.

## 4. Conventions
Source-only, like `@unimatrix/e2e-helpers`. Consumers resolve `src/*.ts` through a Vite alias plus a tsconfig `paths` entry, so this package's tsconfig extends `base.json` rather than `library.json`: `composite` forbids the cross-package `paths` mapping onto `packages/ui/src`, and the emit would be dead weight nothing reads.

## 5. Working Agreements
Two wiring requirements in every consuming app, plus one in this package. `infra/scripts/check-app-wiring.sh` fails closed on the two app-side ones, in `pnpm check`/`pnpm verify` and CI's `Verify` step `App wiring` — but it walks `apps/*` only, so it is not the safety net for every consumer: `lab` carries both requirements and neither is checked there.

- `@source "../../../packages/chrome/src/**/*.{ts,tsx}"` in the app's stylesheet. Tailwind v4 source detection does not reach a sibling package; without it the shell's utilities are never emitted. Check the relative depth actually resolves — a wrong number of `../` is still a valid `@source` line and emits nothing.
- `@tanstack/react-router` in the app's Vite `dedupe`. Two resolved copies means the shell's `useRouterState` reads a router context the app's `RouterProvider` never wrote to.
- `@tanstack/react-router` stays a **peer** dependency here, so the consuming app supplies the one copy. Nothing checks this: `.syncpackrc.json` exempts peer ranges from the one-version rule, and no script reads `peerDependencies`.
