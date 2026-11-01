import {
  RiAlertLine,
  RiArrowRightLine,
  RiBox3Line,
  RiEyeLine,
  RiEyeOffLine,
  RiPulseLine,
  RiRocketLine,
  RiScales3Line,
  RiTerminalBoxLine,
  RiTimeLine,
  RiUploadCloud2Line,
} from "@remixicon/react";
import type {
  DeployAttemptRecord,
  DeployHealthHistoryResponse,
  DeployReconciliationResponse,
  DeployStateResponse,
} from "@unimatrix/shared";
import {
  HealthHistory,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@unimatrix/ui";
import {
  Alert,
  AlertTitle,
  Button,
  DigestCard,
  DigestCardGrid,
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  STATUS_DOT_CLASSES,
  STATUS_TEXT_CLASSES,
  cn,
  type StatusTone,
} from "@unimatrix/ui/editor";

import {
  attemptNeedsAttention,
  durationLabel,
  outcomeLabel,
  reconciliationSummary,
  shortTag,
} from "./presentation";

type OverviewProps = {
  app: DeployStateResponse["apps"][number];
  latest: DeployAttemptRecord | undefined;
  historyState: "loading" | "unavailable" | "ready";
  attempts: DeployAttemptRecord[];
  health: DeployHealthHistoryResponse | undefined;
  reconciliation: DeployReconciliationResponse | undefined;
  onTab: (tab: string) => void;
  onAttempt: (id: string) => void;
};

function relativeAge(from: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - from) / 60_000));
  if (minutes < 1) return "< 1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function countdown(to: number, now: number): string {
  const minutes = Math.max(0, Math.round((to - now) / 60_000));
  if (minutes < 1) return "< 1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function attemptTone(attempt: DeployAttemptRecord): StatusTone {
  if (attemptNeedsAttention(attempt)) return "bad";
  if (attempt.outcome === "landed" || attempt.lateLandedAt !== null) return "ok";
  return "warn";
}

function OpenCard({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className="size-6 text-muted-foreground hover:bg-transparent hover:text-foreground"
          onClick={onOpen}
          size="icon-sm"
          variant="ghost"
        >
          <RiArrowRightLine aria-hidden="true" className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  );
}

function VisibilityIcon({ publicStatus }: { publicStatus: boolean }) {
  const Icon = publicStatus ? RiEyeLine : RiEyeOffLine;
  const label = publicStatus ? "Public status" : "Private status";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          role="img"
          aria-label={label}
          className="inline-flex shrink-0 text-muted-foreground"
        >
          <Icon className="size-4" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  );
}

function ContainerDetails({
  app,
  latest,
}: Pick<OverviewProps, "app"> & { latest: DeployAttemptRecord }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="w-fit text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Container details
        </button>
      </PopoverTrigger>
      <PopoverContent className="rounded-none text-xs" align="start">
        <p className="break-all">Before: {latest.baseline?.containerId ?? "none"}</p>
        <p className="break-all">After: {latest.after?.containerId ?? "not observed"}</p>
        <p className="break-all">
          Currently visible:{" "}
          {app.container.kind === "matched" ? app.container.containerId : "no container matched"}
        </p>
        {attemptNeedsAttention(latest) ? (
          <p className="mt-3 leading-relaxed">
            {latest.failureReason ??
              "The requested replacement container was not verified before the deployment deadline."}
          </p>
        ) : null}
        <p className="mt-3 leading-relaxed">
          A changed container ID proves recreation. Deployed requires verified image correlation.
        </p>
      </PopoverContent>
    </Popover>
  );
}

export function Overview({
  app,
  latest,
  historyState,
  attempts,
  health,
  reconciliation,
  onTab,
  onAttempt,
}: OverviewProps) {
  const now = Date.now();
  const summary = reconciliation ? reconciliationSummary(reconciliation, app.appDir) : null;
  const result = reconciliation?.results.find((entry) => entry.appDir === app.appDir);
  const diff =
    result?.outcome === "diffed" && result.diff.verdict === "matched" ? result.diff : null;
  const missing =
    diff?.envFindings.filter((entry) => entry.state === "missing" || entry.state === "blank")
      .length ?? 0;
  const undeclared = diff?.envFindings.filter((entry) => entry.state === "undeclared").length ?? 0;
  const settings = diff?.settingFindings.length ?? 0;
  const routing = diff?.routing;
  const routingCount = routing
    ? routing.missingHosts.length + routing.unexpectedHosts.length + Number(routing.portMismatch)
    : 0;
  const completedAt = latest?.completedAt ?? latest?.landedAt ?? latest?.recreatedAt ?? null;
  const hasProbe = health !== undefined && health.current.checkedAt !== null;
  const healthState =
    health?.current.state === "up"
      ? "Responding"
      : health?.current.state === "down"
        ? "Not responding"
        : "Unknown";
  const lastDeployText =
    historyState === "loading"
      ? "Loading attempt history…"
      : historyState === "unavailable"
        ? "Attempt history unavailable"
        : !latest
          ? "No deployment yet"
          : latest.after !== null
            ? "Container replaced"
            : "Deployment in progress";

  return (
    <DigestCardGrid
      className="h-full min-h-0"
      spanning={
        <DigestCard
          className="min-h-56 min-w-0"
          height="fill"
          icon={<RiTimeLine />}
          label="Recent deploys"
          action={
            <OpenCard
              label="All deploys"
              onOpen={() => {
                onTab("deploys");
              }}
            />
          }
        >
          <ul className="divide-y divide-border/60">
            {attempts.slice(0, 4).map((attempt) => {
              const tone = attemptTone(attempt);
              return (
                <li
                  className="-mx-4 flex w-[calc(100%+2rem)] min-w-0 items-center gap-4 px-5 py-3 hover:bg-muted/40"
                  key={attempt.id}
                >
                  <span
                    aria-hidden="true"
                    className={cn("size-2 shrink-0 rounded-full", STATUS_DOT_CLASSES[tone])}
                  />
                  <span
                    className="w-20 shrink-0 font-mono text-xs text-foreground"
                    title={attempt.image?.tag}
                  >
                    {attempt.image ? shortTag(attempt.image.tag) : "Configured"}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                    title={attempt.commitSubject ?? undefined}
                  >
                    {attempt.commitSubject ?? "Commit subject unavailable"}
                  </span>
                  <span className={cn("shrink-0 text-xs", STATUS_TEXT_CLASSES[tone])}>
                    {outcomeLabel(attempt)}
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {relativeAge(attempt.requestedAt, now)}
                  </span>
                  <Button
                    aria-label={`Log for ${attempt.image ? shortTag(attempt.image.tag) : "configured image"}`}
                    className="size-6 shrink-0"
                    onClick={() => {
                      onAttempt(attempt.id);
                    }}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <RiTerminalBoxLine aria-hidden="true" className="size-4" />
                  </Button>
                </li>
              );
            })}
          </ul>
          {!attempts.length ? (
            <p className="text-sm text-muted-foreground">
              {historyState === "ready"
                ? "No recorded attempts."
                : historyState === "loading"
                  ? "Loading attempts…"
                  : "Attempt history unavailable."}
            </p>
          ) : null}
        </DigestCard>
      }
    >
      <DigestCard
        icon={<RiUploadCloud2Line />}
        label="Last deploy"
        action={
          latest ? (
            <OpenCard
              label="Read the log"
              onOpen={() => {
                onAttempt(latest.id);
              }}
            />
          ) : undefined
        }
      >
        <div className="flex min-h-0 flex-1 flex-col">
          {latest && attemptNeedsAttention(latest) ? (
            <Alert variant="destructive" className="p-3">
              <RiAlertLine aria-hidden="true" />
              <AlertTitle>
                {latest.outcome === "failed" ? "Deployment failed" : "Container unchanged"}
              </AlertTitle>
            </Alert>
          ) : (
            <p className="text-sm font-medium text-foreground">{lastDeployText}</p>
          )}
        </div>
        <div className="mt-auto flex shrink-0 flex-col gap-2">
          {latest ? <ContainerDetails app={app} latest={latest} /> : null}
          {latest ? (
            <p className="text-xs text-muted-foreground">
              {relativeAge(latest.requestedAt, now)} ago · tag{" "}
              <span className="font-mono">
                {latest.image ? shortTag(latest.image.tag) : "configured image"}
              </span>
              {completedAt === null
                ? null
                : ` · took ${durationLabel(completedAt - latest.requestedAt)}`}
            </p>
          ) : null}
        </div>
      </DigestCard>

      <DigestCard
        icon={<RiRocketLine />}
        label="Running"
        action={
          <OpenCard
            label="Deploy history"
            onOpen={() => {
              onTab("deploys");
            }}
          />
        }
      >
        {app.container.kind === "unknown" ? (
          <Empty className="min-h-0 p-0">
            <EmptyHeader className="gap-1">
              <EmptyMedia className="mb-0" variant="icon">
                <RiBox3Line />
              </EmptyMedia>
              <EmptyTitle className="text-sm">No container matched</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <p className="text-sm leading-snug font-medium break-words text-foreground">
              {app.container.commitSubject ?? app.container.commit ?? "Commit subject unavailable"}
            </p>
            <p
              className="mt-auto truncate font-mono text-xs text-muted-foreground"
              title={`${app.container.image} · ${app.container.containerId}`}
            >
              {app.container.image} · {app.container.containerId}
            </p>
          </>
        )}
      </DigestCard>

      <DigestCard
        icon={<RiPulseLine />}
        label="Health"
        action={
          <>
            {!hasProbe ? <VisibilityIcon publicStatus={app.publicStatus} /> : null}
            <OpenCard
              label="Probe history"
              onOpen={() => {
                onTab("health");
              }}
            />
          </>
        }
      >
        {!hasProbe ? (
          <Empty className="min-h-0 p-0">
            <EmptyHeader className="gap-1">
              <EmptyMedia className="mb-0" variant="icon">
                <RiPulseLine />
              </EmptyMedia>
              <EmptyTitle className="text-sm">Awaiting first probe</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-x-2 text-sm leading-snug font-medium text-foreground">
              <VisibilityIcon publicStatus={app.publicStatus} />
              <span>
                {health.summary.uptimePercent === null
                  ? "No measured uptime"
                  : `${health.summary.uptimePercent.toFixed(2)}%`}
              </span>
              <span className="text-xs font-normal text-muted-foreground">
                · {Math.round(health.summary.downMs / 60_000)}m down in 30d
              </span>
            </p>
            <HealthHistory days={health.days.slice(-14)} />
            <p className="mt-auto text-xs text-muted-foreground">
              {healthState} · checked {relativeAge(health.current.checkedAt ?? now, now)} ago
              {health.freshness !== "fresh" ? ` · ${health.freshness}` : ""}
              {health.summary.coveragePercent < 99.99
                ? ` · ${health.summary.coveragePercent.toFixed(2)}% observed`
                : ""}
            </p>
          </>
        )}
      </DigestCard>

      <DigestCard
        icon={<RiScales3Line />}
        label="Configuration"
        action={
          summary?.showDetail ? (
            <OpenCard
              label="Review reconciliation"
              onOpen={() => {
                onTab("reconcile");
              }}
            />
          ) : undefined
        }
      >
        <p
          className={cn(
            "text-sm font-medium",
            summary?.count
              ? "text-destructive"
              : result?.outcome === "diffed" && result.diff.verdict === "missing"
                ? "text-amber-500"
                : "text-foreground",
          )}
        >
          {summary?.label ?? "Snapshot unavailable"}
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {missing ? (
            <button
              type="button"
              className="text-destructive underline-offset-4 hover:underline"
              onClick={() => {
                onTab("reconcile");
              }}
            >
              {missing} missing
            </button>
          ) : null}
          {undeclared ? (
            <button
              type="button"
              className="text-amber-500 underline-offset-4 hover:underline"
              onClick={() => {
                onTab("reconcile");
              }}
            >
              {undeclared} undeclared
            </button>
          ) : null}
          {settings ? <span className="text-muted-foreground">{settings} settings</span> : null}
          {routingCount ? (
            <span className="text-muted-foreground">{routingCount} routing</span>
          ) : null}
        </div>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {reconciliation?.observedAt == null
              ? "Not checked"
              : `Checked ${relativeAge(reconciliation.observedAt, now)} ago`}
            {reconciliation?.freshness === "stale" ? " · stale" : ""}
            {reconciliation?.nextRunAt == null
              ? ""
              : ` · next check in ${countdown(reconciliation.nextRunAt, now)}`}
          </p>
        </div>
      </DigestCard>
    </DigestCardGrid>
  );
}
