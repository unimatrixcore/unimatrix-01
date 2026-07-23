import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/train")({
  head: () => ({
    meta: [{ title: "Cube Trainer - Train" }],
  }),
});
