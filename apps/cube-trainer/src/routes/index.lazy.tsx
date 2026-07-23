import { Link, createLazyFileRoute } from "@tanstack/react-router";
import { RiArrowRightUpLine, RiShapeLine, RiShapesLine } from "@remixicon/react";

import { ALGORITHM_SETS } from "@/features/algorithms/algorithm-sets";
import { Badge, Button, Card } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/")({
  component: IndexRoute,
});

const SETS = [
  { icon: RiShapeLine, key: "oll" as const, to: "/oll" as const },
  { icon: RiShapesLine, key: "pll" as const, to: "/pll" as const },
];

function IndexRoute() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-medium tracking-[-0.03em] text-foreground">
        Pick a case set to train.
      </h1>

      <div className="grid gap-4 sm:grid-cols-2">
        {SETS.map(({ icon: Icon, key, to }) => {
          const set = ALGORITHM_SETS[key];

          return (
            <Card
              className="site-panel site-panel-strong flex h-full flex-col gap-3 px-5 py-5"
              key={key}
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-medium tracking-[-0.02em] text-foreground">
                  {set.label}
                </h2>
                <Badge className="gap-1.5" variant="outline">
                  <Icon aria-hidden="true" className="size-3.5" />
                  {set.cases.length} cases
                </Badge>
              </div>
              <p className="flex-1 text-sm leading-6 text-muted-foreground">
                {set.description}
              </p>
              <Button asChild className="w-fit gap-2">
                <Link to={to}>
                  Train {set.label}
                  <RiArrowRightUpLine aria-hidden="true" className="size-4" />
                </Link>
              </Button>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
