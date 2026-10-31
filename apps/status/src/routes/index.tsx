import { createFileRoute } from "@tanstack/react-router";

import { publicStatusQueryOptions } from "@/features/status/queries/public-status";

export const Route = createFileRoute("/")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(publicStatusQueryOptions());
  },
  head: () => ({
    meta: [
      { title: "Unimatrix Status" },
      { name: "description", content: "Unimatrix service status and 30-day uptime." },
    ],
  }),
});
