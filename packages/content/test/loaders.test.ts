import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { ContentValidationError } from "../src/errors.js";
import { loadSiteContent } from "../src/node.js";

describe("repo-backed content loaders", () => {
  it("loads and sorts the site content from the content directory", () => {
    const rootDir = mkdtempSync("loc-43-content-");
    try {
      mkdirSync(join(rootDir, "content", "home"), { recursive: true });
      mkdirSync(join(rootDir, "content", "projects"), { recursive: true });
      mkdirSync(join(rootDir, "content", "blog"), { recursive: true });

      writeFileSync(
        join(rootDir, "content", "home", "index.md"),
        `---
title: Home title
intro: Intro copy
summary: Summary copy
mission: Mission copy
---
Home body.
`,
      );
      writeFileSync(
        join(rootDir, "content", "projects", "berrybot.md"),
        `---
title: BerryBot
slug: berrybot
publishedAt: 2025-05-01
summary: Project summary
status: active
featured: true
---
Project body.
`,
      );
      writeFileSync(
        join(rootDir, "content", "blog", "older.md"),
        `---
title: Older post
slug: older-post
publishedAt: 2025-01-01
summary: Older summary
---
Older body.
`,
      );
      writeFileSync(
        join(rootDir, "content", "blog", "newer.md"),
        `---
title: Newer post
slug: newer-post
publishedAt: 2026-01-01
summary: Newer summary
---
Newer body.
`,
      );

      const siteContent = loadSiteContent({ rootDir });

      expect(siteContent.home.frontmatter.title).toBe("Home title");
      expect(siteContent.projects[0]?.slug).toBe("berrybot");
      expect(siteContent.blog.map((entry) => entry.slug)).toEqual([
        "newer-post",
        "older-post",
      ]);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it("surfaces file-specific validation errors for invalid authored content", () => {
    const rootDir = mkdtempSync("loc-43-content-");
    try {
      mkdirSync(join(rootDir, "content", "home"), { recursive: true });
      mkdirSync(join(rootDir, "content", "projects"), { recursive: true });
      mkdirSync(join(rootDir, "content", "blog"), { recursive: true });

      writeFileSync(
        join(rootDir, "content", "home", "index.md"),
        `---
title: Home title
intro: Intro copy
summary: Summary copy
mission: Mission copy
---
Home body.
`,
      );
      writeFileSync(
        join(rootDir, "content", "projects", "broken.md"),
        `---
title: Broken project
slug: broken-project
publishedAt: not-a-date
summary: Broken summary
status: active
---
Broken body.
`,
      );

      try {
        loadSiteContent({ rootDir });
        throw new Error("Expected loadSiteContent to throw for invalid authored content.");
      } catch (error) {
        expect(error).toBeInstanceOf(ContentValidationError);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(
          /content\/projects\/broken\.md: publishedAt: expected a valid date string/u,
        );
      }
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it("keeps repo-relative file paths stable when rootDir has a trailing separator", () => {
    const rootDir = mkdtempSync("loc-43-content-");
    try {
      mkdirSync(join(rootDir, "content", "home"), { recursive: true });
      mkdirSync(join(rootDir, "content", "projects"), { recursive: true });
      mkdirSync(join(rootDir, "content", "blog"), { recursive: true });

      writeFileSync(
        join(rootDir, "content", "home", "index.md"),
        `---
title: Home title
intro: Intro copy
summary: Summary copy
mission: Mission copy
---
Home body.
`,
      );
      writeFileSync(
        join(rootDir, "content", "projects", "berrybot.md"),
        `---
title: BerryBot
slug: berrybot
publishedAt: 2025-05-01
summary: Project summary
status: active
---
Project body.
`,
      );
      writeFileSync(
        join(rootDir, "content", "blog", "entry.md"),
        `---
title: Blog entry
slug: blog-entry
publishedAt: 2026-01-01
summary: Blog summary
---
Blog body.
`,
      );

      const siteContent = loadSiteContent({ rootDir: `${rootDir}${sep}` });

      expect(siteContent.home.filePath).toBe("content/home/index.md");
      expect(siteContent.projects[0]?.filePath).toBe("content/projects/berrybot.md");
      expect(siteContent.blog[0]?.filePath).toBe("content/blog/entry.md");
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });
});
