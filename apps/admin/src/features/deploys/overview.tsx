import {
  RiRocketLine,
  RiPulseLine,
  RiBox3Line,
  RiScales3Line,
  RiHistoryLine,
  RiEyeLine,
  RiEyeOffLine,
} from "@remixicon/react";
import type {
  DeployStateResponse,
  DeployAttemptRecord,
  DeployHealthHistoryResponse,
  DeployReconciliationResponse,
} from "@unimatrix/shared";
import {
  Button,
  DigestCard,
  DigestCardGrid,
  DigestRow,
  DigestRowList,
  UptimeStrip,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@unimatrix/ui";
import {
  outcomeLabel,
  attemptNeedsAttention,
  formatTime,
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
  const VisibilityIcon = app.publicStatus ? RiEyeLine : RiEyeOffLine;
  const summary = reconciliation ? reconciliationSummary(reconciliation, app.appDir) : null;
  const link = (tab: string) => (
    <Button
      variant="ghost"
      size="icon-sm"
      className="size-6"
      aria-label={`Open ${tab}`}
      onClick={() => {
        onTab(tab);
      }}
    >
      →
    </Button>
  );
  return (
    <DigestCardGrid
      spanning={
        <DigestCard
          height="fill"
          icon={<RiHistoryLine />}
          label="Recent deploys"
          action={link("deploys")}
        >
          <DigestRowList>
            {attempts.slice(0, 4).map((run) => (
              <DigestRow
                key={run.id}
                itemKey={
                  <span title={run.image?.tag}>
                    {run.image ? shortTag(run.image.tag) : "Configured"}
                  </span>
                }
                description={run.commitSubject ?? "Commit subject unavailable"}
                meta={formatTime(run.requestedAt)}
                state={outcomeLabel(run)}
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      onAttempt(run.id);
                    }}
                  >
                    View log
                  </Button>
                }
              />
            ))}
          </DigestRowList>
          {!attempts.length && (
            <p className="text-sm text-muted-foreground">
              {historyState === "ready"
                ? "No recorded attempts."
                : historyState === "loading"
                  ? "Loading attempts…"
                  : "Attempt history unavailable."}
            </p>
          )}
        </DigestCard>
      }
    >
      <DigestCard
        icon={<RiRocketLine />}
        label="Last deploy"
        action={link("deploys")}
        primary={
          <p
            className={`text-sm ${latest && attemptNeedsAttention(latest) ? "text-destructive" : ""}`}
          >
            {historyState !== "ready"
              ? historyState === "loading"
                ? "Loading attempt history…"
                : "Attempt history unavailable"
              : latest
                ? outcomeLabel(latest)
                : "Never deployed"}
          </p>
        }
        supporting={
          <p className="text-xs text-muted-foreground">
            {latest?.failureReason
              ? `${latest.failureReason} Open this attempt’s log before retrying.`
              : latest?.outcome === "timed-out"
                ? "The requested replacement was not verified before the deadline. Inspect this attempt’s events."
                : latest?.outcome === "failed"
                  ? "The deployment request failed. Inspect this attempt’s events before retrying."
                  : latest?.outcome === "recreated"
                    ? "Container replacement observed; requested image could not be verified."
                    : latest
                      ? `Trigger: ${latest.trigger}`
                      : "Attempts appear after a deployment request."}
          </p>
        }
        meta={
          <div className="text-xs text-muted-foreground">
            <p>{latest ? formatTime(latest.requestedAt) : "No request recorded"}</p>
            {latest && (
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" className="mt-1 underline underline-offset-4">
                    Container details
                  </button>
                </PopoverTrigger>
                <PopoverContent className="max-w-[90vw] break-all text-xs">
                  <p>Before: {latest.baseline?.containerId ?? "Not observed"}</p>
                  <p>After: {latest.after?.containerId ?? "Not observed"}</p>
                  <p>Image correlation: {latest.correlation}</p>
                  <p className="mt-2">
                    Currently visible:{" "}
                    {app.container.kind === "matched"
                      ? app.container.containerId
                      : "No matched container"}
                  </p>
                  <p className="mt-2">
                    A changed container ID proves recreation. Deployed requires verified image
                    correlation.
                  </p>
                </PopoverContent>
              </Popover>
            )}
          </div>
        }
      />
      <DigestCard
        icon={<RiPulseLine />}
        label="Health"
        action={link("health")}
        primary={
          <p className="flex items-center gap-2 text-sm">
            <VisibilityIcon
              className="size-4 text-muted-foreground"
              role="img"
              aria-label={app.publicStatus ? "Public status" : "Private status"}
            />
            {health?.summary.uptimePercent == null
              ? "No observed uptime"
              : `${health.summary.uptimePercent.toFixed(2)}% uptime`}
          </p>
        }
        supporting={
          <>
            <p className="mb-2 text-xs text-muted-foreground">
              Probe: {health?.current.state ?? "unknown"} · {health?.freshness ?? "missing"}
            </p>
            <UptimeStrip
              label="Last 14 days of uptime"
              samples={(health?.days ?? []).slice(-14).map((day) => ({
                key: String(day.from),
                label: new Date(day.from).toLocaleDateString(undefined, { timeZone: "UTC" }),
                uptime: day.uptimePercent === null ? null : day.uptimePercent / 100,
              }))}
            />
          </>
        }
        meta={
          <p className="text-xs text-muted-foreground">
            {health
              ? `${health.summary.coveragePercent.toFixed(2)}% observed · ${formatTime(health.current.checkedAt)}`
              : "No health observations available"}
          </p>
        }
      />
      <DigestCard
        icon={<RiBox3Line />}
        label="Running"
        action={link("config")}
        primary={
          <p className="break-all text-sm">
            {app.container.kind === "matched"
              ? (app.container.commitSubject ??
                app.container.commit?.slice(0, 7) ??
                app.container.imageTag ??
                "Image metadata unavailable")
              : "No matched container"}
          </p>
        }
        supporting={
          <p
            className="truncate text-xs text-muted-foreground"
            title={app.container.kind === "matched" ? app.container.image : undefined}
          >
            {app.container.kind === "matched"
              ? app.container.image
              : `Mapping: ${app.container.reason}`}
          </p>
        }
        meta={
          <div className="text-xs text-muted-foreground">
            {app.container.kind === "matched" && (
              <p className="truncate" title={app.container.containerId}>
                {app.container.containerId.slice(0, 12)} ·{" "}
                {app.container.name ?? "Container name unknown"}
              </p>
            )}
            {app.container.kind === "matched" && (
              <>
                <p>Started: {formatTime(app.container.startedAt)}</p>
              </>
            )}
            <p>
              {app.container.freshness} · observed {formatTime(app.container.observedAt)}
            </p>
          </div>
        }
      />
      <DigestCard
        icon={<RiScales3Line />}
        label="Configuration"
        action={summary?.showDetail ? link("reconcile") : undefined}
        primary={<p className="text-sm">{summary?.label ?? "Snapshot unavailable"}</p>}
        supporting={
          <p className="text-xs text-muted-foreground">
            Stored configuration · {reconciliation?.freshness ?? "missing"}. Detection does not
            compare secret values.
          </p>
        }
        meta={
          <div className="text-xs text-muted-foreground">
            <p>Checked: {formatTime(reconciliation?.observedAt ?? null)}</p>
            <p>Next: {formatTime(reconciliation?.nextRunAt ?? null)}</p>
          </div>
        }
      />
    </DigestCardGrid>
  );
}
