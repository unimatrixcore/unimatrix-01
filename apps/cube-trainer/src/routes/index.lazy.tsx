import { Link, createLazyFileRoute } from "@tanstack/react-router";
import { RiBookOpenLine, RiFlashlightLine } from "@remixicon/react";

export const Route = createLazyFileRoute("/")({
  component: IndexRoute,
});

const MODES = [
  { icon: RiBookOpenLine, label: "Learn", to: "/learn" as const },
  { icon: RiFlashlightLine, label: "Drill", to: "/drill" as const },
];

function IndexRoute() {
  return (
    <div className="space-y-10">
      <div className="flex items-center justify-center gap-3 text-center">
        <img alt="" className="size-9 shrink-0 opacity-90" src="/favicon.svg" />
        <h1 className="text-3xl font-medium tracking-[-0.03em] text-foreground">Cube Trainer</h1>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {MODES.map(({ icon: Icon, label, to }) => (
          <Link
            className="site-panel site-panel-strong flex h-40 flex-col items-center justify-center gap-3 text-center transition-colors hover:bg-primary/8"
            key={to}
            to={to}
          >
            <Icon aria-hidden="true" className="size-6 text-muted-foreground" />
            <span className="text-lg font-medium tracking-[-0.02em] text-foreground">{label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
