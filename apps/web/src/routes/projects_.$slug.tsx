import {
  createFileRoute,
  notFound,
} from "@tanstack/react-router";

import { getProjectEntryBySlug } from "@/features/content/site-content";

export const Route = createFileRoute("/projects_/$slug")({
  loader: ({ params }) => {
    const project = getProjectEntryBySlug(params.slug);

    if (!project) {
      throw createProjectNotFoundError(params.slug);
    }

    return project;
  },
});

function createProjectNotFoundError(slug: string): Error {
  return Object.assign(new Error(`Project not found: ${slug}`), notFound());
}
