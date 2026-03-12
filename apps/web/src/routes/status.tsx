import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  RiLoader4Line,
  RiPulseLine,
  RiRouteLine,
  RiServerLine,
  RiTimer2Line,
} from "@remixicon/react";

import { Badge, Card, Separator, cn } from "@unimatrix/ui";
import { scaffoldStatusQueryOptions } from "@/features/status/queries/get-scaffold-status";

export const Route = createFileRoute("/status")({
  component: StatusRoute,
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(scaffoldStatusQueryOptions()),
});

function StatusRoute() {
  const { data, isFetching } = useQuery(scaffoldStatusQueryOptions());
  const statusCards = [
    {
      icon: RiRouteLine,
      label: "Router",
      value: data?.routerStatus ?? "Loading route state...",
    },
    {
      icon: RiServerLine,
      label: "Query",
      value: data?.queryStatus ?? "Loading query state...",
    },
    {
      icon: RiPulseLine,
      label: "Mode",
      value: data?.mode ?? "Resolving environment...",
    },
    {
      icon: RiTimer2Line,
      label: "Last checked",
      value: data?.checkedAt ?? "Waiting for first fetch...",
    },
  ];

  return (
    <div className="grid gap-6">
      <Card className="border-border/60 bg-card/94 shadow-[0_18px_60px_-36px_color-mix(in_oklab,var(--foreground)_22%,transparent)]">
        <div className="space-y-4 px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-2">
              <Badge className="gap-1.5">
                <RiPulseLine aria-hidden="true" className="size-3.5" />
                Status route
              </Badge>
              <h2 className="text-2xl leading-tight font-medium tracking-tight">
                Router and query providers are active in the shared shell.
              </h2>
            </div>
            <Badge
              variant={isFetching ? "default" : "outline"}
              className={cn("gap-1.5", isFetching && "animate-pulse")}
            >
              <RiLoader4Line
                aria-hidden="true"
                className={cn("size-3.5", isFetching && "animate-spin")}
              />
              Query {isFetching ? "updating" : "idle"}
            </Badge>
          </div>

          <p className="max-w-3xl text-sm leading-7 text-muted-foreground lg:text-base">
            This route still uses a local async query plus a route loader that
            prefetches into the shared `QueryClient`. LOC-38 only changes the
            visual system and shared primitive plumbing around that behavior.
          </p>

          <Separator />

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {statusCards.map(({ icon: Icon, label, value }) => (
              <Card
                key={label}
                size="sm"
                className="border-border/60 bg-card/80 shadow-none backdrop-blur"
              >
                <div className="space-y-3 px-4">
                  <div className="flex items-center justify-between gap-3">
                    <Badge variant="secondary">{label}</Badge>
                    <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
                  </div>
                  <p className="text-sm leading-7 text-muted-foreground">{value}</p>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}
