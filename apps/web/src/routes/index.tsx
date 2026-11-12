import { createFileRoute } from "@tanstack/react-router";

import { backgroundListQueryOptions } from "@unimatrix/instant-list";
import { publishedBackgroundPostsOptions } from "@/features/content/queries/background-posts";

export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureInfiniteQueryData(
        backgroundListQueryOptions(publishedBackgroundPostsOptions("blog")),
      ),
      context.queryClient.ensureInfiniteQueryData(
        backgroundListQueryOptions(publishedBackgroundPostsOptions("project", true)),
      ),
    ]);
  },
  head: () => ({
    meta: [
      { title: "Unimatrix-01 - Home" },
      {
        name: "description",
        content:
          "A collection of projects, experiments, and the occasional blog post from Gwenny, a developer working mostly in TypeScript and Node.js.",
      },
    ],
  }),
});
