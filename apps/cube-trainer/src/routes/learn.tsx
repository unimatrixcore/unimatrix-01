import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/learn")({
  head: () => ({
    meta: [{ title: "Cube Trainer - Learn" }],
  }),
});
