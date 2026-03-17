---
title: Building a typed content baseline for the new site
slug: building-a-typed-content-baseline
publishedAt: 2026-03-16
summary: Why the new monorepo starts with typed, repo-backed content for home, projects, and blog.
description: A short note about keeping the first content system explicit, safe, and small.
---
The new site needs a content system that is small enough to trust and explicit enough to maintain. Instead of jumping straight to a CMS, the baseline starts with typed frontmatter, repo-backed files, and validation that fails loudly when authoring goes off contract.

## Why start this way

The goal is not to keep the public site simplistic forever. The goal is to make the first content path obvious.

That means:

- authored files live in Git
- frontmatter is typed and validated
- the public site can render safe GitHub-flavored markdown without introducing a runtime execution path

> Good baseline content systems should be inspectable before they are clever.

If you want the implementation-side companion, the [Unimatrix-01 project entry](/projects/unimatrix-01) now describes the same boundary from the platform angle.

## Current rollout checklist

- [x] typed frontmatter contracts for home, projects, and blog
- [x] explicit raw-import registry in the web app
- [x] safe GFM rendering with tables, task lists, links, images, and syntax-colored fenced code
- [ ] richer docs and notes collections
- [ ] Borg Markdown as a future parser layer

## Route behavior snapshot

| Surface | Current mode | Why it exists |
| --- | --- | --- |
| Public site | Safe GFM | Richer authored content without raw HTML execution |
| Content loading | Manual registry | Easy to review and hard to misunderstand |
| Future parser work | Borg Markdown | Reserved for a stricter safe component model |

## Current renderer contract

```ts
const renderMode = {
  html: "disabled",
  images: "root-relative-or-absolute",
  internalLinks: "spa-handoff",
  markdown: "safe-gfm",
} as const;
```

The current renderer intentionally ignores raw HTML blocks.

<span data-raw-html="suppressed">This should never render as HTML.</span>

## Visual reference

![Ops console topology](/content/ops-console-topology.svg)

That keeps the first public-site content path boring in the best way: visible in Git, easy to review, and ready for better tooling later.
