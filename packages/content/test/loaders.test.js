import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ContentValidationError } from "../src/errors.js";
import { loadSiteContent } from "../src/node.js";
describe("repo-backed content loaders", () => {
    it("loads and sorts the site content from the content directory", (test) => {
        const rootDir = mkdtempSync("loc-43-content-");
        test.after(() => {
            rmSync(rootDir, { force: true, recursive: true });
        });
        mkdirSync(join(rootDir, "content", "home"), { recursive: true });
        mkdirSync(join(rootDir, "content", "projects"), { recursive: true });
        mkdirSync(join(rootDir, "content", "blog"), { recursive: true });
        writeFileSync(join(rootDir, "content", "home", "index.md"), `---
title: Home title
intro: Intro copy
summary: Summary copy
mission: Mission copy
---
Home body.
`);
        writeFileSync(join(rootDir, "content", "projects", "berrybot.md"), `---
title: BerryBot
slug: berrybot
publishedAt: 2025-05-01
summary: Project summary
status: active
featured: true
---
Project body.
`);
        writeFileSync(join(rootDir, "content", "blog", "older.md"), `---
title: Older post
slug: older-post
publishedAt: 2025-01-01
summary: Older summary
---
Older body.
`);
        writeFileSync(join(rootDir, "content", "blog", "newer.md"), `---
title: Newer post
slug: newer-post
publishedAt: 2026-01-01
summary: Newer summary
---
Newer body.
`);
        const siteContent = loadSiteContent({ rootDir });
        assert.equal(siteContent.home.frontmatter.title, "Home title");
        assert.equal(siteContent.projects[0]?.slug, "berrybot");
        assert.deepEqual(siteContent.blog.map((entry) => entry.slug), ["newer-post", "older-post"]);
    });
    it("surfaces file-specific validation errors for invalid authored content", (test) => {
        const rootDir = mkdtempSync("loc-43-content-");
        test.after(() => {
            rmSync(rootDir, { force: true, recursive: true });
        });
        mkdirSync(join(rootDir, "content", "home"), { recursive: true });
        mkdirSync(join(rootDir, "content", "projects"), { recursive: true });
        mkdirSync(join(rootDir, "content", "blog"), { recursive: true });
        writeFileSync(join(rootDir, "content", "home", "index.md"), `---
title: Home title
intro: Intro copy
summary: Summary copy
mission: Mission copy
---
Home body.
`);
        writeFileSync(join(rootDir, "content", "projects", "broken.md"), `---
title: Broken project
slug: broken-project
publishedAt: not-a-date
summary: Broken summary
status: active
---
Broken body.
`);
        assert.throws(() => loadSiteContent({ rootDir }), {
            message: /content\/projects\/broken\.md: publishedAt: expected a valid date string/u,
            name: ContentValidationError.name,
        });
    });
});
