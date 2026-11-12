import { createFileRoute } from "@tanstack/react-router";

import { backgroundListQueryOptions } from "@unimatrix/instant-list";
import { publishedBackgroundPostsOptions } from "@/features/content/queries/background-posts";

export const Route = createFileRoute("/projects")({
  loader: ({ context }) =>
    context.queryClient.ensureInfiniteQueryData(
      backgroundListQueryOptions(publishedBackgroundPostsOptions("project")),
    ),
  head: () => ({
    meta: [
      { title: "Unimatrix-01 - Projects" },
      {
        name: "description",
        content:
          "Projects and experiments by Gwenny, from web apps and typed API contracts to Rubik's Cube training tools.",
      },
    ],
  }),
});
