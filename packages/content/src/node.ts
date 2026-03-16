import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { CONTENT_ROOT_DIRECTORY } from "./collections.js";
import type {
  BlogEntry,
  HomePageContent,
  ProjectEntry,
  SiteContent,
} from "./documents.js";
import {
  parseBlogContentFile,
  parseHomeContentFile,
  parseProjectContentFile,
  sortEntriesByPublishedAtDesc,
} from "./parsers.js";

export interface LoadContentOptions {
  rootDir?: string;
}

export function loadHomeContent(
  options: LoadContentOptions = {},
): HomePageContent {
  const contentRoot = resolveContentRootDirectory(options.rootDir);
  const filePath = join(contentRoot, "home", "index.md");

  return parseHomeContentFile(
    readFileSync(filePath, "utf8"),
    toRepositoryPath(options.rootDir, filePath),
  );
}

export function loadProjectEntries(
  options: LoadContentOptions = {},
): ProjectEntry[] {
  return sortEntriesByPublishedAtDesc(
    loadCollectionEntries(options.rootDir, "projects", parseProjectContentFile),
  );
}

export function loadBlogEntries(
  options: LoadContentOptions = {},
): BlogEntry[] {
  return sortEntriesByPublishedAtDesc(
    loadCollectionEntries(options.rootDir, "blog", parseBlogContentFile),
  );
}

export function loadSiteContent(options: LoadContentOptions = {}): SiteContent {
  return {
    blog: loadBlogEntries(options),
    home: loadHomeContent(options),
    projects: loadProjectEntries(options),
  };
}

function loadCollectionEntries<T>(
  rootDir: string | undefined,
  collectionDirectory: string,
  parseEntry: (source: string, filePath: string) => T,
): T[] {
  const collectionRoot = join(
    resolveContentRootDirectory(rootDir),
    collectionDirectory,
  );

  return readdirSync(collectionRoot)
    .filter((entryName) => entryName.endsWith(".md") && !entryName.startsWith("_"))
    .map((entryName) => join(collectionRoot, entryName))
    .filter((entryPath) => statSync(entryPath).isFile())
    .map((entryPath) =>
      parseEntry(
        readFileSync(entryPath, "utf8"),
        toRepositoryPath(rootDir, entryPath),
      ),
    );
}

function resolveContentRootDirectory(rootDir: string | undefined): string {
  return join(rootDir ?? process.cwd(), CONTENT_ROOT_DIRECTORY);
}

function toRepositoryPath(
  rootDir: string | undefined,
  absolutePath: string,
): string {
  const repositoryRoot = rootDir ?? process.cwd();
  return absolutePath.slice(repositoryRoot.length + 1).split(sep).join("/");
}