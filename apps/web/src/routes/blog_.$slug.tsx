import {
  createFileRoute,
  notFound,
} from "@tanstack/react-router";

import { getBlogEntryBySlug } from "@/features/content/site-content";

export const Route = createFileRoute("/blog_/$slug")({
  loader: ({ params }) => {
    const entry = getBlogEntryBySlug(params.slug);

    if (!entry) {
      throw createBlogNotFoundError(params.slug);
    }

    return entry;
  },
});

function createBlogNotFoundError(slug: string): Error {
  return Object.assign(new Error(`Blog entry not found: ${slug}`), notFound());
}
