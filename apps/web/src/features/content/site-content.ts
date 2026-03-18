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

import { indexEntriesBySlug } from "./lookups";

import homeSource from "../../../../../content/home/index.md?raw";
import placeholderPostSource from "../../../../../content/blog/placeholder-post.md?raw";
import placeholderProjectSource from "../../../../../content/projects/placeholder-project.md?raw";

export const homeContent: HomePageContent = parseHomeContentFile(
  homeSource,
  "content/home/index.md",
);

export const projectEntries: ProjectEntry[] = sortEntriesByPublishedAtDesc([
  parseProjectContentFile(
    placeholderProjectSource,
    "content/projects/placeholder-project.md",
  ),
]);

export const blogEntries: BlogEntry[] = sortEntriesByPublishedAtDesc([
  parseBlogContentFile(placeholderPostSource, "content/blog/placeholder-post.md"),
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

const projectEntriesBySlug = indexEntriesBySlug(projectEntries);
const blogEntriesBySlug = indexEntriesBySlug(blogEntries);

export function getProjectEntryBySlug(slug: string): ProjectEntry | undefined {
  return projectEntriesBySlug.get(slug);
}

export function getBlogEntryBySlug(slug: string): BlogEntry | undefined {
  return blogEntriesBySlug.get(slug);
}
