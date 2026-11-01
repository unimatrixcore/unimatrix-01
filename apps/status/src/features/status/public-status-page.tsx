import { useQuery } from "@tanstack/react-query";
import { RiCheckboxCircleLine, RiErrorWarningLine, RiRefreshLine } from "@remixicon/react";
import { ToolShell } from "@unimatrix/chrome/tool";
import { Button, HealthHistory, type HealthHistoryDay } from "@unimatrix/ui/public";
import type { PublicDeploymentStatusResponse } from "@unimatrix/shared";

import { publicStatusQueryOptions } from "./queries/public-status";

type PublicService = PublicDeploymentStatusResponse["apps"][number];

const labels = { up: "Operational", down: "Unavailable", degraded: "Degraded" };
const colors = { up: "text-emerald-400", down: "text-destructive", degraded: "text-amber-400" };
const DAY_MS = 86_400_000;

export function completeStatusHistory(
  history: readonly HealthHistoryDay[],
  now: number,
): HealthHistoryDay[] {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const byDay = new Map(history.map((day) => [day.from, day]));
  return Array.from({ length: 30 }, (_, index) => {
    const from = today - (29 - index) * DAY_MS;
    return (
      byDay.get(from) ?? {
        from,
        to: Math.min(from + DAY_MS, now),
        uptimePercent: null,
        coveragePercent: 0,
      }
    );
  });
}

function ServiceHistory({ service }: { service: PublicService }) {
  const days = completeStatusHistory(service.history, Date.now());
  const uptime = service.summary.uptimePercent;
  return (
    <li className="space-y-4 p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{service.displayName}</h3>
        <span className={`flex items-center gap-2 text-xs ${colors[service.state]}`}>
          <span aria-hidden="true" className="size-1.5 bg-current" />
          {labels[service.state]}
        </span>
      </div>
      <HealthHistory days={days} label={`${service.displayName} daily uptime`} />
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>30 days ago</span>
        <span className="h-px flex-1 bg-border" />
        <span title={`${service.summary.coveragePercent.toFixed(2)}% observed`}>
          {uptime === null ? "No observations" : `${uptime.toFixed(2)}% uptime`}
        </span>
        <span className="h-px flex-1 bg-border" />
        <span>Today</span>
      </div>
    </li>
  );
}

export function PublicStatusPage() {
  const status = useQuery(publicStatusQueryOptions());
  const apps = status.isError ? undefined : status.data?.apps;
  const healthy = apps !== undefined && apps.length > 0 && apps.every((app) => app.state === "up");
  const heading = status.isPending
    ? "Checking services"
    : status.isError
      ? "Status unavailable"
      : apps?.length === 0
        ? "No published services"
        : healthy
          ? "All services operational"
          : apps?.some((app) => app.state === "down")
            ? "Some services unavailable"
            : "Some services degraded";
  return (
    <ToolShell
      className="max-w-4xl pt-8 sm:pt-12 lg:pt-20 [&>main]:justify-start"
      homeHref="https://unimatrix-01.dev"
    >
      <div>
        <header className="flex items-center justify-between gap-4">
          <h1 className="flex min-w-0 items-center gap-3 text-xl font-medium tracking-tight sm:text-2xl">
            <img src="/logo.png" alt="" className="size-9 shrink-0 object-contain" />
            Unimatrix Status
          </h1>
          <Button
            variant="outline"
            size="icon"
            aria-label={status.isFetching ? "Refreshing status" : "Refresh status"}
            onClick={() => {
              void status.refetch();
            }}
            disabled={status.isFetching}
          >
            <RiRefreshLine
              className={status.isFetching ? "size-4 animate-spin" : "size-4"}
              aria-hidden="true"
            />
          </Button>
        </header>
        <div
          className="mt-12 flex items-center gap-3 border border-border bg-card p-5 sm:mt-16 sm:p-6"
          role="status"
        >
          {healthy ? (
            <RiCheckboxCircleLine aria-hidden="true" className="size-5 shrink-0 text-emerald-400" />
          ) : (
            <RiErrorWarningLine aria-hidden="true" className="size-5 shrink-0 text-amber-400" />
          )}
          <h2 className="text-base font-medium">{heading}</h2>
        </div>
        {apps !== undefined && apps.length > 0 ? (
          <ul
            aria-label="Services"
            className="mt-16 divide-y divide-border border border-border bg-card sm:mt-24"
          >
            {apps.map((service, index) => (
              <ServiceHistory key={`${service.displayName}-${index}`} service={service} />
            ))}
          </ul>
        ) : null}
      </div>
    </ToolShell>
  );
}
