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
