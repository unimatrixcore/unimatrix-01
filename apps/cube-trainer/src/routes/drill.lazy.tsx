import { createLazyFileRoute } from "@tanstack/react-router";

import { DrillSetView } from "@/features/trainer/components/drill-set-view";

export const Route = createLazyFileRoute("/drill")({
  component: DrillRoute,
});

function DrillRoute() {
  return <DrillSetView />;
}
