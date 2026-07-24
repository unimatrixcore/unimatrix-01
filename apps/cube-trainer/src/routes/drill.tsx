import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/drill")({
  head: () => ({
    meta: [{ title: "Cube Trainer - Drill" }],
  }),
});
