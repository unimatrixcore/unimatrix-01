import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/oll")({
  head: () => ({
    meta: [{ title: "Cube Trainer - OLL" }],
  }),
});
