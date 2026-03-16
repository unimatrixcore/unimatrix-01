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

export function findProjectEntryBySlug<T extends SluggedEntry>(
  entries: readonly T[],
  slug: string,
): T | undefined {
  return findEntryBySlug(entries, slug);
}

export function findBlogEntryBySlug<T extends SluggedEntry>(
  entries: readonly T[],
  slug: string,
): T | undefined {
  return findEntryBySlug(entries, slug);
}