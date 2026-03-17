import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  RiLoader4Line,
  RiPulseLine,
  RiRouteLine,
  RiServerLine,
  RiTimer2Line,
} from "@remixicon/react";

import { scaffoldStatusQueryOptions } from "@/features/status/queries/get-scaffold-status";
import { Badge, Card, Separator, cn } from "@unimatrix/ui";

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
      <Card className="border border-border/70 bg-background/56 shadow-[0_34px_130px_-82px_color-mix(in_oklab,var(--foreground)_76%,transparent)] backdrop-blur-xl">
        <div className="grid gap-8 px-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="gap-1.5">
                <RiPulseLine aria-hidden="true" className="size-3.5" />
                Status route
              </Badge>
              <Badge variant="outline">Query cache prefetch</Badge>
            </div>

            <div className="space-y-3">
              <h2 className="max-w-4xl text-3xl leading-[0.96] font-medium tracking-[-0.05em] lg:text-5xl">
                The shared API contract baseline is wired through the public console.
              </h2>
              <p className="max-w-3xl text-sm leading-7 text-muted-foreground lg:text-base">
                The route loader still prefetches into the shared `QueryClient`, and the client
                state still comes from `@unimatrix/api-client` parsing the shared `GET /health`
                contract exported by `@unimatrix/shared`.
              </p>
            </div>

            <Separator />

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {statusCards.map(({ icon: Icon, label, value }) => (
                <Card
                  key={label}
                  size="sm"
                  className="border border-border/70 bg-background/42 shadow-none backdrop-blur"
                >
                  <div className="space-y-3 px-4">
                    <div className="flex items-center justify-between gap-3">
                      <Badge variant="secondary">{label}</Badge>
                      <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
                    </div>
                    <p className="text-sm leading-7 text-foreground/88">{value}</p>
                  </div>
                </Card>
              ))}
            </div>
          </div>

          <div className="grid gap-3 self-start">
            <div className="border border-border/70 bg-background/40 px-4 py-4">
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
              <p className="mt-4 text-sm leading-7 text-foreground/88">
                The command deck preserves the same fetch path and data shape while presenting the
                route with denser system framing.
              </p>
            </div>
            <div className="border border-border/70 bg-background/40 px-4 py-4">
              <p className="text-[0.7rem] uppercase tracking-[0.28em] text-muted-foreground">
                Surface notes
              </p>
              <p className="mt-3 text-sm leading-7 text-foreground/88">
                Query behavior is unchanged in this branch. Only the route chrome and density have
                been refreshed.
              </p>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
