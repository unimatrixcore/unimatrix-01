import { useQuery } from "@tanstack/react-query";
import { createLazyFileRoute } from "@tanstack/react-router";
import {
  RiLoader4Line,
  RiPulseLine,
  RiRouteLine,
  RiServerLine,
  RiTimer2Line,
} from "@remixicon/react";

import { statusSnapshotQueryOptions } from "@/features/status/queries/get-status-snapshot";
import { Badge, Card, Separator, cn } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/status")({
  component: StatusRoute,
});

function StatusRoute() {
  const { data, isFetching } = useQuery(statusSnapshotQueryOptions());
  const statusCards = [
    {
      icon: RiRouteLine,
      label: "Router",
      value: data?.routerStatus ?? "Loading route state...",
    },
    {
      icon: RiServerLine,
      label: "Client",
      value: data?.clientStatus ?? "Loading shared contract status...",
    },
    {
      icon: RiPulseLine,
      label: "Service",
      value: data?.service ?? "Waiting for API response...",
    },
    {
      icon: RiTimer2Line,
      label: "Status",
      value: data?.status ?? "Waiting for API response...",
    },
    {
      icon: RiTimer2Line,
      label: "Last checked",
      value: data?.checkedAt ?? "Waiting for first fetch...",
    },
  ];

  return (
    <div className="grid gap-6">
      <Card className="borg-panel borg-grid-surface overflow-hidden border-primary/20 bg-background/82">
        <div className="grid gap-8 px-6 py-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="gap-1.5">
                <RiPulseLine aria-hidden="true" className="size-3.5" />
                Diagnostic array
              </Badge>
              <Badge variant="outline">Query cache prefetch</Badge>
            </div>

            <div className="space-y-3">
              <h2 className="max-w-4xl text-3xl leading-[0.9] font-medium tracking-[-0.07em] text-foreground lg:text-5xl">
                Collective diagnostics remain linked to the live API surface.
              </h2>
              <p className="max-w-3xl text-sm leading-7 text-muted-foreground lg:text-base lg:leading-8">
                The route loader still prefetches into the shared query client, then this view
                renders the latest health snapshot as a cold systems readout instead of a generic
                dashboard.
              </p>
            </div>

            <Separator className="border-primary/15" />

            <div className="grid gap-3 md:grid-cols-2">
              <div className="borg-subpanel px-4 py-4">
                <p className="borg-data-label">Router path</p>
                <p className="mt-3 text-sm leading-7 text-foreground/88">
                  {data?.routerStatus ?? "Loading route state..."}
                </p>
              </div>

              <div className="borg-subpanel px-4 py-4">
                <p className="borg-data-label">Client path</p>
                <p className="mt-3 text-sm leading-7 text-foreground/88">
                  {data?.clientStatus ?? "Loading shared contract status..."}
                </p>
              </div>
            </div>
          </div>

          <div className="grid gap-3 self-start">
            <div className="borg-subpanel px-4 py-4">
              <Badge
                className={cn("gap-1.5", isFetching && "animate-pulse")}
                variant={isFetching ? "default" : "outline"}
              >
                <RiLoader4Line
                  aria-hidden="true"
                  className={cn("size-3.5", isFetching && "animate-spin")}
                />
                Query {isFetching ? "updating" : "idle"}
              </Badge>
              <p className="mt-4 text-sm leading-7 text-foreground/88">
                Health data remains query-backed. Only the visual framing has been assimilated into
                the Borg surface.
              </p>
            </div>

            <div className="borg-subpanel px-4 py-4">
              <p className="borg-data-label">Surface notes</p>
              <p className="mt-3 text-sm leading-7 text-foreground/88">
                Shared contracts still define the shape of the payload. This page only changes how
                those values are presented.
              </p>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {statusCards.map(({ icon: Icon, label, value }) => (
          <Card key={label} className="borg-panel overflow-hidden" size="sm">
            <div className="space-y-3 px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <Badge variant="secondary">{label}</Badge>
                <Icon aria-hidden="true" className="size-4 text-primary" />
              </div>
              <p className="text-sm leading-7 text-foreground/88">{value}</p>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
