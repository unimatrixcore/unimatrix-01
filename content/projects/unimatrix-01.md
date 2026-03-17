---
title: Unimatrix-01
slug: unimatrix-01
publishedAt: 2026-03-16
summary: The TypeScript monorepo foundation for the future Unimatrix site, packages, and internal tooling.
status: in-progress
repoUrl: https://github.com/gwenphalan/unimatrix-01
featured: true
---
Unimatrix-01 is the new long-term platform. It keeps the public site, shared packages, and future operational tooling in one typed workspace so new work can extend the system without rebuilding the architecture every time.

## Platform shape

The target shape is intentionally monorepo-first:

- `apps/web` for the public everything-site
- `apps/api` for API transport and domain entry points
- `packages/ui`, `packages/content`, and shared contracts for reuse
- Git-backed authored content under `content/`

That means the public site can evolve without losing the package boundaries that later internal tools will need.

## Public site move

The current route work is about more than visual polish. The site now presents itself like a small command deck, and the authored content path is explicit all the way through:

![Ops console topology](/content/ops-console-topology.svg)

The renderer now supports safe GitHub-flavored markdown for project and blog bodies while still refusing raw HTML and executable MDX. That keeps the authoring surface expressive without making it opaque.

## Registry and contracts

The content system is still deliberately small. The current registry stays manual in `apps/web/src/features/content/site-content.ts`, and the route loaders keep consuming typed entries instead of a runtime collection loader.

```ts
const publicSiteBoundary = {
  authoring: "repo-backed markdown",
  registry: "explicit raw imports",
  rendering: "safe-gfm",
  runtimeHtml: false,
} as const;
```

That tradeoff is intentional: clarity now, broader loader architecture later.

## Next boundaries

- keep public content repo-backed and typed
- add richer docs and notes collections later
- preserve Borg Markdown as future parser work instead of mixing it into the first migration

If you want the architectural rationale from the writing side too, the [typed content baseline note](/blog/building-a-typed-content-baseline) walks through the same boundary from the content system angle.
