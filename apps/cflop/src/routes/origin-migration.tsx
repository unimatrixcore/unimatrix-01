import { createFileRoute } from "@tanstack/react-router";

import { routeHead } from "@/lib/route-head";

export const Route = createFileRoute("/origin-migration")({
  head: () =>
    routeHead({
      path: "/origin-migration",
      title: "CFLOP - Transfer saved progress",
      description: "Transfer saved CFLOP progress from a previous hostname.",
      indexable: false,
    }),
});
