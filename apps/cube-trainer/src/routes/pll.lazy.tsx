import { createLazyFileRoute } from "@tanstack/react-router";

import { AlgorithmSetView } from "@/features/algorithms/components/algorithm-set-view";

export const Route = createLazyFileRoute("/pll")({
  component: PllRoute,
});

function PllRoute() {
  return <AlgorithmSetView setId="pll" />;
}
