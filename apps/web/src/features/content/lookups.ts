interface SluggedEntry {
  slug: string;
}

export function indexEntriesBySlug<T extends SluggedEntry>(
  entries: readonly T[],
): ReadonlyMap<string, T> {
  const indexedEntries = new Map<string, T>();

  for (const entry of entries) {
    if (indexedEntries.has(entry.slug)) {
      throw new Error(`Duplicate content slug detected: ${entry.slug}`);
    }

    indexedEntries.set(entry.slug, entry);
  }

  return indexedEntries;
}

export function findEntryBySlug<T extends SluggedEntry>(
  entries: readonly T[],
  slug: string,
): T | undefined {
  return entries.find((entry) => entry.slug === slug);
}
