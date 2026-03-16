import type { BlogEntry, ProjectEntry } from "@unimatrix/content";

interface SluggedEntry {
  slug: string;
}

export function indexEntriesBySlug<T extends SluggedEntry>(
  entries: readonly T[],
): ReadonlyMap<string, T> {
  return new Map(entries.map((entry) => [entry.slug, entry]));
}

export function findEntryBySlug<T extends SluggedEntry>(
  entries: readonly T[],
  slug: string,
): T | undefined {
  return entries.find((entry) => entry.slug === slug);
}

export function findProjectEntryBySlug(
  entries: readonly ProjectEntry[],
  slug: string,
): ProjectEntry | undefined {
  return findEntryBySlug(entries, slug);
}

export function findBlogEntryBySlug(
  entries: readonly BlogEntry[],
  slug: string,
): BlogEntry | undefined {
  return findEntryBySlug(entries, slug);
}