import { type BackgroundListOptions } from "@unimatrix/instant-list";
import type { ContentPostSummary, ContentPostType } from "@unimatrix/shared";

import { apiClient } from "@/lib/api-client";

export function publishedBackgroundPostsOptions(
  type: ContentPostType,
  featured = false,
): BackgroundListOptions<ContentPostSummary, string> {
  return {
    queryKey: ["content", "pages", type, { featured }],
    getItemId: (post) => post.id,
    pageSize: 50,
    backgroundDelayMs: 250,
    fetchPage: async ({ cursor, signal, priority, limit }) => {
      const result = await apiClient.listPosts(
        {
          type,
          limit,
          ...(cursor === null ? {} : { cursor }),
          ...(featured ? { featured: "true" } : {}),
        },
        { signal, priority },
      );
      return { items: result.posts, nextCursor: result.nextCursor ?? null };
    },
  };
}
