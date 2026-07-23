import { createLazyFileRoute } from "@tanstack/react-router";

import { LearnSetView } from "@/features/learn/components/learn-set-view";

export const Route = createLazyFileRoute("/learn")({
  component: LearnRoute,
});

function LearnRoute() {
  return <LearnSetView />;
}
