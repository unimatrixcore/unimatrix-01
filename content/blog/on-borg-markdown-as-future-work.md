---
title: On Borg Markdown as future work
slug: on-borg-markdown-as-future-work
publishedAt: 2025-06-15
summary: Borg Markdown still matters conceptually, but it belongs in a future safe parser layer rather than this first baseline.
description: A note on separating long-term content ideas from the first typed markdown system.
---
Borg Markdown is still an important idea because it treats content, interaction, and presentation as something that should stay transparent to authors. But this issue is deliberately narrower than that.

For the first public-site baseline, the safer move is plain repo-backed markdown with explicit frontmatter and no executable content path. That keeps the platform stable while leaving room for a future parser that can stay on a strict safe whitelist.