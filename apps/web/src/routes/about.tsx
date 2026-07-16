import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [{ title: "Unimatrix-01 - About" }],
  }),
});
