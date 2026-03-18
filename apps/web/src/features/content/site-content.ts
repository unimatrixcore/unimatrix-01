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

import { normalizePortfolioCopy } from "@/features/public-site/copy";
import { indexEntriesBySlug } from "./lookups";

import homeSource from "../../../../../content/home/index.md?raw";
import placeholderPostSource from "../../../../../content/blog/placeholder-post.md?raw";
import placeholderProjectSource from "../../../../../content/projects/placeholder-project.md?raw";

const parsedHomeContent = parseHomeContentFile(homeSource, "content/home/index.md");

export const homeContent: HomePageContent = {
  ...parsedHomeContent,
  body: normalizePortfolioCopy(parsedHomeContent.body),
  frontmatter: {
    ...parsedHomeContent.frontmatter,
    intro: normalizePortfolioCopy(parsedHomeContent.frontmatter.intro),
    mission: normalizePortfolioCopy(parsedHomeContent.frontmatter.mission),
    summary: normalizePortfolioCopy(parsedHomeContent.frontmatter.summary),
  },
};

const parsedProjectEntries = [
  parseProjectContentFile(placeholderProjectSource, "content/projects/placeholder-project.md"),
];

export const projectEntries: ProjectEntry[] = sortEntriesByPublishedAtDesc([
  ...parsedProjectEntries.map((entry) => ({
    ...entry,
    body: normalizePortfolioCopy(entry.body),
    excerpt: normalizePortfolioCopy(entry.excerpt),
    frontmatter: {
      ...entry.frontmatter,
      summary: normalizePortfolioCopy(entry.frontmatter.summary),
      title: normalizePortfolioCopy(entry.frontmatter.title),
    },
  })),
]);

const parsedBlogEntries = [
  parseBlogContentFile(placeholderPostSource, "content/blog/placeholder-post.md"),
];

export const blogEntries: BlogEntry[] = sortEntriesByPublishedAtDesc([
  ...parsedBlogEntries.map((entry) => ({
    ...entry,
    body: normalizePortfolioCopy(entry.body),
    excerpt: normalizePortfolioCopy(entry.excerpt),
    frontmatter: {
      ...entry.frontmatter,
      description: normalizePortfolioCopy(
        entry.frontmatter.description ?? entry.frontmatter.summary,
      ),
      summary: normalizePortfolioCopy(entry.frontmatter.summary),
      title: normalizePortfolioCopy(entry.frontmatter.title),
    },
  })),
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
