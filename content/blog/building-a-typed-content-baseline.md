---
title: Building a typed content baseline for the new site
slug: building-a-typed-content-baseline
publishedAt: 2026-03-16
summary: Why the new monorepo starts with typed, repo-backed content for home, projects, and blog.
description: A short note about keeping the first content system explicit, safe, and small.
---
The new site needs a content system that is small enough to trust and explicit enough to maintain. Instead of jumping straight to a CMS, the baseline starts with typed frontmatter, repo-backed files, and validation that fails loudly when authoring goes off contract.

That keeps the first public-site content path boring in the best way: visible in Git, easy to review, and ready for better tooling later.