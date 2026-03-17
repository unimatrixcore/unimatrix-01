import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentValidationError } from "../src/errors.js";
import {
  parseBlogContentFile,
  parseHomeContentFile,
  parseProjectContentFile,
} from "../src/index.js";

describe("content parsers", () => {
  it("parses the home document contract", () => {
    const homeContent = parseHomeContentFile(
      `---
title: Home title
intro: Intro copy
summary: Summary copy
mission: Mission copy
---
Paragraph one.

Paragraph two.
`,
      "content/home/index.md",
    );

    assert.equal(homeContent.frontmatter.title, "Home title");
    assert.equal(homeContent.excerpt, "Paragraph one.");
  });

  it("parses the project and blog entry contracts", () => {
    const projectEntry = parseProjectContentFile(
      `---
title: BerryBot
slug: berrybot
publishedAt: 2025-05-01
summary: Project summary
status: active
featured: true
repoUrl: https://github.com/gwenphalan/berrybot
---
BerryBot body.
`,
      "content/projects/berrybot.md",
    );
    const blogEntry = parseBlogContentFile(
      `---
title: Typed baseline
slug: typed-baseline
publishedAt: 2026-03-16
summary: Blog summary
description: Blog description
---
Blog body.
`,
      "content/blog/typed-baseline.md",
    );

    assert.equal(projectEntry.frontmatter.featured, true);
    assert.equal(projectEntry.slug, "berrybot");
    assert.equal(blogEntry.frontmatter.description, "Blog description");
  });

  it("derives plain-text excerpts from rich markdown without code fences or table separators", () => {
    const blogEntry = parseBlogContentFile(
      `---
title: Linked baseline
slug: linked-baseline
publishedAt: 2026-03-16
summary: Blog summary
---
## Renderer brief

\`\`\`ts
const unsafe = "<script />";
\`\`\`

- [x] Review the [public renderer](/blog/building-a-typed-content-baseline) and the ![system map](/content/ops-console-topology.svg) before shipping.

| Surface | Mode |
| --- | --- |
| Public site | Safe GFM |
`,
      "content/blog/linked-baseline.md",
    );

    assert.equal(
      blogEntry.excerpt,
      "Review the public renderer and the system map before shipping.",
    );
  });

  it("preserves pipe characters in prose excerpts outside table blocks", () => {
    const blogEntry = parseBlogContentFile(
      `---
title: Union types
slug: union-types
publishedAt: 2026-03-16
summary: Blog summary
---
Use \`A | B\` to express union types.
`,
      "content/blog/union-types.md",
    );

    assert.equal(blogEntry.excerpt, "Use A | B to express union types.");
  });

  it("strips empty fenced code blocks before deriving excerpts", () => {
    const blogEntry = parseBlogContentFile(
      `---
title: Empty fence
slug: empty-fence
publishedAt: 2026-03-16
summary: Blog summary
---
\`\`\`
\`\`\`

First visible paragraph.
`,
      "content/blog/empty-fence.md",
    );

    assert.equal(blogEntry.excerpt, "First visible paragraph.");
  });

  it("treats compact GFM separator rows as table syntax", () => {
    const blogEntry = parseBlogContentFile(
      `---
title: Compact table
slug: compact-table
publishedAt: 2026-03-16
summary: Blog summary
---
| Surface | Mode |
| - | - |
| Public site | Safe GFM |
`,
      "content/blog/compact-table.md",
    );

    assert.equal(blogEntry.excerpt, "Surface Mode Public site Safe GFM");
  });

  it("reports missing required frontmatter with a file-specific error", () => {
    assert.throws(
      () =>
        parseProjectContentFile(
          `---
title: BerryBot
slug: berrybot
publishedAt: 2025-05-01
status: active
---
Missing summary.
`,
          "content/projects/berrybot.md",
        ),
      {
        message: /content\/projects\/berrybot\.md: summary: expected a non-empty string/u,
        name: ContentValidationError.name,
      },
    );
  });
});
