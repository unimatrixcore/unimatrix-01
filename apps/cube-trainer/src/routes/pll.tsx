import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/pll")({
  head: () => ({
    meta: [{ title: "Cube Trainer - PLL" }],
  }),
});
