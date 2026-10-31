import { createFileRoute } from "@tanstack/react-router";

import { selectFeaturedProjects, toBlogEntry, toProjectEntry } from "@/features/content/entries";
import { publishedPostsQueryOptions } from "@/features/content/queries/content-posts";
import { homeContent } from "@/features/content/site-content";

/** How many recent entries the homepage's blog column shows. */
const HOME_BLOG_ENTRY_COUNT = 2;

export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    // Both collections are needed to paint the page, and the two requests are
    // independent, so they go out together rather than in series.
    const [blog, projects] = await Promise.all([
      context.queryClient.ensureQueryData(publishedPostsQueryOptions("blog")),
      context.queryClient.ensureQueryData(publishedPostsQueryOptions("project")),
    ]);

    return {
      blogEntries: blog.posts.slice(0, HOME_BLOG_ENTRY_COUNT).map(toBlogEntry),
      home: homeContent,
      projects: selectFeaturedProjects(projects.posts).map(toProjectEntry),
    };
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
