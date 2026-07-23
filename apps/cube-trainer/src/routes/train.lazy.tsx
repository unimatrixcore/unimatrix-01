import { createLazyFileRoute } from "@tanstack/react-router";

import { TrainSetView } from "@/features/trainer/components/train-set-view";

export const Route = createLazyFileRoute("/train")({
  component: TrainRoute,
});

function TrainRoute() {
  return <TrainSetView />;
}
