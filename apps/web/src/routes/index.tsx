import { Link, createFileRoute } from "@tanstack/react-router";
import {
  RiArrowRightUpLine,
  RiLayoutGridLine,
  RiRouteLine,
  RiStackLine,
} from "@remixicon/react";

import { Badge, Button, Card, Separator } from "@unimatrix/ui";

export const Route = createFileRoute("/")({
  component: IndexRoute,
});

const proofPoints = [
  {
    detail:
      "Button, Card, Badge, Separator, and cn now live in the shared UI package.",
    icon: RiLayoutGridLine,
    label: "Shared primitives",
  },
  {
    detail:
      "The existing scaffold routes are the visual proof surface instead of a throwaway demo.",
    icon: RiRouteLine,
    label: "Same route count",
  },
  {
    detail:
      "Future public-site work can compose from the baseline without redoing tokens or helper plumbing.",
    icon: RiStackLine,
    label: "Monorepo ready",
  },
];

function IndexRoute() {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.9fr)]">
      <Card className="border-border/60 bg-card/94 shadow-[0_18px_60px_-36px_color-mix(in_oklab,var(--foreground)_22%,transparent)]">
        <div className="space-y-6 px-6">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="gap-1.5">
              <RiLayoutGridLine aria-hidden="true" className="size-3.5" />
              Baseline adopted
            </Badge>
            <Badge variant="outline">apps/web</Badge>
          </div>

          <div className="space-y-3">
            <h2 className="text-2xl leading-tight font-medium tracking-tight lg:text-3xl">
              The scaffold routes now consume the shared design-system baseline
              instead of handcrafted shell styles.
            </h2>
            <p className="max-w-2xl text-sm leading-7 text-muted-foreground lg:text-base">
              LOC-38 stays intentionally narrow: monorepo-aware preset setup,
              shared baseline primitives, and visual adoption only on the
              existing surfaces.
            </p>
          </div>

          <Separator />

          <div className="flex flex-wrap gap-3">
            <Button asChild className="gap-2">
              <Link to="/status">
                Inspect provider status
                <RiArrowRightUpLine aria-hidden="true" className="size-4" />
              </Link>
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid gap-4">
        {proofPoints.map(({ detail, icon: Icon, label }) => (
          <Card
            key={label}
            size="sm"
            className="border-border/60 bg-card/82 shadow-none backdrop-blur"
          >
            <div className="space-y-3 px-4">
              <div className="flex items-center justify-between gap-3">
                <Badge variant="secondary">{label}</Badge>
                <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
              </div>
              <p className="text-sm leading-7 text-muted-foreground">{detail}</p>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
