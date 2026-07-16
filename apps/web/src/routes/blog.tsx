import { createFileRoute } from "@tanstack/react-router";

import { blogEntries } from "@/features/content/site-content";

export const Route = createFileRoute("/blog")({
  loader: () => blogEntries,
  head: () => ({
    meta: [{ title: "Unimatrix-01 - Blog" }],
  }),
});
