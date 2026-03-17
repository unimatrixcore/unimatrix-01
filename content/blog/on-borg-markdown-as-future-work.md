---
title: On Borg Markdown as future work
slug: on-borg-markdown-as-future-work
publishedAt: 2025-06-15
summary: The CMS friction behind Borg Markdown still matters, but the new site keeps that idea separate from the first safe public v1 content system.
description: A rewritten note about Borg UI, CMS friction, and why Borg Markdown remains future parser work instead of part of the first migration.
---
The original version of this idea came out of a very specific frustration: I was building Borg UI, imagining a full rebuild around it, and then bouncing straight back into a CMS experience that felt like an entirely different product. The styling mismatch was annoying, but the bigger problem was architectural. The authoring layer felt opaque right where I wanted the system to stay the most hackable.

That tension is what made Borg Markdown interesting. I wanted a format where authored content could stay close to the design system, where component intent was visible in source, and where the content layer did not disappear behind an admin surface that resisted inspection or customization.

That idea still matters, but the new monorepo needs a narrower first move. Public v1 now ships safe GitHub-flavored markdown rendering on top of repo-backed files with typed frontmatter, explicit validation, and no executable content path. That keeps the platform dependable while preserving Borg Markdown as future parser work with a strict safe whitelist instead of mixing an experimental language into the first migration.

In other words: the legacy post keeps the reason, while the monorepo changes the timing. The safe baseline comes first. The richer content language can wait until it has a clearer boundary and a more deliberate implementation.
