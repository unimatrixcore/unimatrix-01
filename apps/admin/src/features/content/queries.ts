import type { BackgroundListOptions } from "@unimatrix/instant-list";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@unimatrix/api-client";
import type { ContentPostSummary, ContentPostType, ListPostsResponse } from "@unimatrix/shared";

import { retryUnlessClientError } from "@/lib/retry";

/**
 * Admin reads, keyed separately from the public ones. The two answer different
 * questions about the same rows — `/content/posts` returns published entries,
 * `/content/admin/posts` returns drafts and archived ones too — so sharing a
 * key would let a public list render admin-only rows out of the cache.
 */
export const adminQueryKeys = {
  all: ["admin", "content"] as const,
  list: (type?: ContentPostType) => ["admin", "content", "list", type ?? "all"] as const,
};

/**
 * Every post in a collection, in every publication state.
 */
export function adminPostsQueryOptions(client: ApiClient, type?: ContentPostType) {
  return queryOptions<ListPostsResponse>({
    queryKey: adminQueryKeys.list(type),
    queryFn: () => client.adminListPosts(type === undefined ? {} : { type }),
    staleTime: 15_000,
    retry: retryUnlessClientError,
  });
}

/** The row for one slug, or `undefined` while the list is still loading. */
export function findPostBySlug(
  posts: readonly ContentPostSummary[] | undefined,
  slug: string,
): ContentPostSummary | undefined {
  return posts?.find((post) => post.slug === slug);
}

/**
 * Drops every cached admin content read after a write.
 *
 * There is no public content cache to invalidate here — that lives in
 * `apps/web`, on a different origin with its own query client — so this only
 * touches the admin keys.
 */
export async function invalidateContent(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: adminQueryKeys.all });
}

export function adminPostsListOptions(
  client: ApiClient,
  type: ContentPostType = "blog",
): BackgroundListOptions<ContentPostSummary, string> {
  return {
    queryKey: [...adminQueryKeys.all, "background-list", type],
    getItemId: (post) => post.id,
    pageSize: 100,
    backgroundDelayMs: 250,
    staleTime: 15_000,
    fetchPage: async ({ cursor, limit, signal, priority }) => {
      const response = await client.adminListPosts(
        { type, limit, ...(cursor === null ? {} : { cursor }) },
        { signal, priority },
      );
      return { items: response.posts, nextCursor: response.nextCursor ?? null };
    },
  };
}
