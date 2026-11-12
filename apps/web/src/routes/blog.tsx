import { createFileRoute } from "@tanstack/react-router";

import { backgroundListQueryOptions } from "@unimatrix/instant-list";
import { publishedBackgroundPostsOptions } from "@/features/content/queries/background-posts";

export const Route = createFileRoute("/blog")({
  loader: ({ context }) =>
    context.queryClient.ensureInfiniteQueryData(
      backgroundListQueryOptions(publishedBackgroundPostsOptions("blog")),
    ),
  head: () => ({
    meta: [
      { title: "Unimatrix-01 - Blog" },
      {
        name: "description",
        content:
          "Writing on software architecture, typed contracts, and the security questions that keep distributed systems honest.",
      },
    ],
  }),
});
