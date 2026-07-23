import { createLazyFileRoute } from "@tanstack/react-router";

import { AlgorithmSetView } from "@/features/algorithms/components/algorithm-set-view";

export const Route = createLazyFileRoute("/oll")({
  component: OllRoute,
});

function OllRoute() {
  return <AlgorithmSetView setId="oll" />;
}
