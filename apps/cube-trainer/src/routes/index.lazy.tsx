import { Link, createLazyFileRoute } from "@tanstack/react-router";
import { RiArrowRightUpLine, RiShapeLine, RiShapesLine } from "@remixicon/react";

import { ALGORITHM_SETS } from "@/features/algorithms/algorithm-sets";
import { Badge, Button, Card } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/")({
  component: IndexRoute,
});

function IndexRoute() {
  return (
    <div className="space-y-12">
      <section className="max-w-2xl space-y-4 pb-2">
        <h1 className="text-3xl leading-[0.92] font-medium tracking-[-0.06em] text-foreground sm:text-4xl lg:text-[3.2rem]">
          Learn and train 3x3 last-layer algorithms.
        </h1>
        <p className="max-w-xl text-[0.95rem] leading-7 text-foreground/86">
          Browse every OLL and PLL case with move sequences, then drill them as
          flashcards until they are fast and automatic.
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="site-panel site-panel-strong flex h-full flex-col gap-4 px-6 py-6">
          <Badge className="w-fit gap-1.5">
            <RiShapeLine aria-hidden="true" className="size-3.5" />
            Orientation
          </Badge>
          <h2 className="text-2xl leading-tight font-medium tracking-[-0.04em] text-foreground">
            {ALGORITHM_SETS.oll.label}
          </h2>
          <p className="flex-1 text-sm leading-7 text-muted-foreground">
            {ALGORITHM_SETS.oll.description}
          </p>
          <p className="text-xs text-muted-foreground">
            {ALGORITHM_SETS.oll.cases.length} cases
          </p>
          <Button asChild className="w-fit gap-2">
            <Link to="/oll">
              Train OLL
              <RiArrowRightUpLine aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        </Card>

        <Card className="site-panel site-panel-strong flex h-full flex-col gap-4 px-6 py-6">
          <Badge className="w-fit gap-1.5">
            <RiShapesLine aria-hidden="true" className="size-3.5" />
            Permutation
          </Badge>
          <h2 className="text-2xl leading-tight font-medium tracking-[-0.04em] text-foreground">
            {ALGORITHM_SETS.pll.label}
          </h2>
          <p className="flex-1 text-sm leading-7 text-muted-foreground">
            {ALGORITHM_SETS.pll.description}
          </p>
          <p className="text-xs text-muted-foreground">
            {ALGORITHM_SETS.pll.cases.length} cases
          </p>
          <Button asChild className="w-fit gap-2">
            <Link to="/pll">
              Train PLL
              <RiArrowRightUpLine aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        </Card>
      </div>
    </div>
  );
}
