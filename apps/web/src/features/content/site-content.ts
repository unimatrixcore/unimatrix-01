import type {
  BlogEntry,
  HomePageContent,
  ProjectEntry,
  SiteContent,
} from "@unimatrix/content";
import {
  parseBlogContentFile,
  parseHomeContentFile,
  parseProjectContentFile,
  sortEntriesByPublishedAtDesc,
} from "@unimatrix/content";

import homeSource from "../../../../../content/home/index.md?raw";
import typedBaselineSource from "../../../../../content/blog/building-a-typed-content-baseline.md?raw";
import borgMarkdownSource from "../../../../../content/blog/on-borg-markdown-as-future-work.md?raw";
import berrybotSource from "../../../../../content/projects/berrybot.md?raw";
import unimatrixSource from "../../../../../content/projects/unimatrix-01.md?raw";

export const homeContent: HomePageContent = parseHomeContentFile(
  homeSource,
  "content/home/index.md",
);

export const projectEntries: ProjectEntry[] = sortEntriesByPublishedAtDesc([
  parseProjectContentFile(berrybotSource, "content/projects/berrybot.md"),
  parseProjectContentFile(unimatrixSource, "content/projects/unimatrix-01.md"),
]);

export const blogEntries: BlogEntry[] = sortEntriesByPublishedAtDesc([
  parseBlogContentFile(
    typedBaselineSource,
    "content/blog/building-a-typed-content-baseline.md",
  ),
  parseBlogContentFile(
    borgMarkdownSource,
    "content/blog/on-borg-markdown-as-future-work.md",
  ),
]);

export const siteContent: SiteContent = {
  blog: blogEntries,
  home: homeContent,
  projects: projectEntries,
};

export const featuredProjects = projectEntries.filter(
  (entry) => entry.frontmatter.featured,
);

export const latestBlogEntries = blogEntries.slice(0, 2);