import { createFileRoute } from "@tanstack/react-router";

import { featuredProjects, latestBlogEntries, homeContent } from "@/features/content/site-content";

export const Route = createFileRoute("/")({
  loader: () => ({
    blogEntries: latestBlogEntries,
    home: homeContent,
    projects: featuredProjects,
  }),
});
