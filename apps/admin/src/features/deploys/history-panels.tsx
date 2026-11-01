import { RiTerminalBoxLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import {
  adminDeployAttemptLogsContract,
  type DeployAttemptRecord,
  type DeployHealthHistoryResponse,
} from "@unimatrix/shared";
import { HealthHistory } from "@unimatrix/ui";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
  toast,
} from "@unimatrix/ui/editor";
import { ScrollArea } from "@unimatrix/ui/scroll-area";

import { useApiClient } from "@/lib/api-client";
import { retryUnlessClientError } from "@/lib/retry";

import { attemptNeedsAttention, durationLabel, formatTime, outcomeLabel } from "./presentation";

type AttemptHistoryProps = {
  attempts: DeployAttemptRecord[];
  onSelect: (id: string) => void;
};

function attemptTag(attempt: DeployAttemptRecord): string {
  return attempt.image?.tag ?? "Current service configuration";
}

function triggerLabel(attempt: DeployAttemptRecord): string {
  return attempt.trigger === "ci"
    ? "Push to main"
    : attempt.trigger === "manual"
      ? "Manual redeploy"
      : "Rollback";
}

function completionTime(attempt: DeployAttemptRecord): number | null {
  return attempt.completedAt ?? attempt.landedAt ?? attempt.recreatedAt ?? null;
}

function AttemptEvidence({ attempt }: { attempt: DeployAttemptRecord }) {
  const before = attempt.baseline?.containerId ?? "Not observed";
  const after = attempt.after?.containerId ?? "Not observed";
  return (
    <details className="mt-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer">Container details</summary>
      <div className="mt-2 space-y-1 whitespace-normal">
        <p className="break-all">Before: {before}</p>
        <p className="break-all">After: {after}</p>
        <p>Image correlation: {attempt.correlation}</p>
        {attempt.image === null ? (
          <p>A replacement container does not verify which image was deployed.</p>
        ) : (
          <p>Deployed requires a replacement container and verified image correlation.</p>
        )}
        {attempt.lateLandedAt === null ? null : (
          <p>Requested image observed after the deadline: {formatTime(attempt.lateLandedAt)}</p>
        )}
      </div>
    </details>
  );
}

export function AttemptHistory({ attempts, onSelect }: AttemptHistoryProps) {
  if (attempts.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No deployment attempts recorded.</p>;
  }

  return (
    <Table className="table-fixed [&_th]:truncate [&_th]:text-xs [&_td]:truncate">
      <TableHeader>
        <TableRow>
          <TableHead className="w-[37%]" title="Tag">
            Tag
          </TableHead>
          <TableHead className="w-[23%]" title="Requested">
            Requested
          </TableHead>
          <TableHead className="w-[20%]" title="Result">
            Result
          </TableHead>
          <TableHead className="w-[12%]" title="Duration">
            Duration
          </TableHead>
          <TableHead className="w-[8%] text-right" title="Log">
            Log
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {attempts.map((attempt) => {
          const completedAt = completionTime(attempt);
          return (
            <TableRow key={attempt.id}>
              <TableCell className="align-top">
                <span className="block truncate font-mono text-xs" title={attemptTag(attempt)}>
                  {attemptTag(attempt)}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {triggerLabel(attempt)}
                </span>
                {attempt.commitSubject && (
                  <span
                    className="block truncate text-xs text-muted-foreground"
                    title={attempt.commitSubject}
                  >
                    {attempt.commitSubject}
                  </span>
                )}
                <AttemptEvidence attempt={attempt} />
              </TableCell>
              <TableCell
                className="truncate align-top text-xs"
                title={formatTime(attempt.requestedAt)}
              >
                {formatTime(attempt.requestedAt)}
              </TableCell>
              <TableCell
                className={cn(
                  "truncate align-top text-xs",
                  attemptNeedsAttention(attempt) && "text-destructive",
                )}
                title={outcomeLabel(attempt)}
              >
                {outcomeLabel(attempt)}
              </TableCell>
              <TableCell className="truncate align-top text-xs text-muted-foreground">
                {completedAt === null ? "—" : durationLabel(completedAt - attempt.requestedAt)}
              </TableCell>
              <TableCell className="text-right align-top">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Logs for ${attemptTag(attempt)} requested ${formatTime(attempt.requestedAt)}`}
                  onClick={() => {
                    onSelect(attempt.id);
                  }}
                >
                  <RiTerminalBoxLine aria-hidden="true" className="size-4" />
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

type AttemptLogsProps = AttemptHistoryProps & {
  app: string;
  selectedId: string | null;
};

const logEvents = {
  "deployment-initialized": { text: "▶ Deployment initialized", tone: "text-sky-400" },
  "deployment-completed": { text: "✔ Deployment process completed", tone: "text-emerald-400" },
  "deployment-failed": { text: "✖ Deployment process failed", tone: "text-destructive" },
};

const unavailableReasons = {
  unassociated: "No deployment log is associated with this attempt.",
  "source-unavailable": "The deployment log source is unavailable.",
  ambiguous: "The log source cannot be uniquely associated with this attempt.",
};

export function AttemptLogs({ app, attempts, selectedId, onSelect }: AttemptLogsProps) {
  const client = useApiClient();
  const attempt = attempts.find((candidate) => candidate.id === selectedId) ?? attempts[0];
  const logs = useQuery({
    queryKey: ["admin", "deploys", "logs", app, attempt?.id],
    queryFn: () => {
      if (!attempt) throw new Error("No attempt selected");
      return client.request(adminDeployAttemptLogsContract, {
        query: { app, attemptId: attempt.id },
      });
    },
    enabled: attempt !== undefined,
    staleTime: 15_000,
    refetchInterval:
      attempt?.outcome === "queued" || attempt?.outcome === "incomplete" ? 5_000 : false,
    retry: retryUnlessClientError,
  });

  if (!attempt) {
    return <p className="p-4 text-sm text-muted-foreground">No deployment attempts recorded.</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <Select value={attempt.id} onValueChange={onSelect}>
          <SelectTrigger className="w-80 max-w-full" aria-label="Deployment attempt">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {attempts.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {attemptTag(candidate)} · {formatTime(candidate.requestedAt)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className={cn("text-xs", attemptNeedsAttention(attempt) && "text-destructive")}>
          {outcomeLabel(attempt)}
        </span>
      </div>
      <ScrollArea
        variant="overlay"
        className="min-h-0 flex-1 bg-black/25"
        viewportProps={{ "aria-label": "Recorded deployment output", tabIndex: 0 }}
      >
        <div className="space-y-3 p-4 text-xs">
          {logs.isPending ? <p role="status">Loading recorded output…</p> : null}
          {logs.isError ? (
            <div role="alert">
              <p>Recorded output could not be loaded.</p>
              <Button
                size="sm"
                variant="ghost"
                disabled={logs.isFetching}
                onClick={() => {
                  void logs.refetch().then((result) => {
                    if (result.isError) toast.error("Recorded output could not be loaded.");
                    else toast.success("Recorded output refreshed.");
                  });
                }}
              >
                Try again
              </Button>
            </div>
          ) : null}
          {(logs.data?.diagnosticLines?.length ?? 0) > 0 && (
            <div role="log" aria-label="Deployment diagnostics" className="space-y-1 font-mono">
              {logs.data?.diagnosticLines?.map((line, index) => (
                <p
                  key={index}
                  className={
                    line.startsWith("✔")
                      ? "text-emerald-400"
                      : line.startsWith("✖")
                        ? "text-destructive"
                        : "text-sky-400"
                  }
                >
                  {line}
                </p>
              ))}
            </div>
          )}
          {logs.data?.status === "unavailable" ? (
            <p>{unavailableReasons[logs.data.reason]}</p>
          ) : null}
          {logs.data?.status === "available" ? (
            <>
              <div
                className="space-y-1 font-mono"
                role="log"
                aria-label="Recognized deployment events"
              >
                {logs.data.events.map((event, index) => (
                  <p key={`${event}-${String(index)}`} className={logEvents[event].tone}>
                    {logEvents[event].text}
                  </p>
                ))}
                {logs.data.events.length === 0 ? <p>No recognized events in this log.</p> : null}
              </div>
              <p className="text-muted-foreground">
                Process events do not establish that the requested image is running. The attempt
                outcome reports runtime verification.
              </p>
              {logs.data.withheld ? (
                <p className="text-muted-foreground">
                  Unrecognized output was withheld to protect credential values.
                </p>
              ) : null}
              {logs.data.truncated ? (
                <p className="text-muted-foreground">
                  This response was truncated at the log delivery limit.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

export function HealthPanel({ history }: { history: DeployHealthHistoryResponse }) {
  const stateLabel = { up: "Responding", down: "Not responding", unknown: "Unknown" };
  return (
    <div className="space-y-5 text-sm">
      <div className="space-y-2">
        <p>{stateLabel[history.current.state]}</p>
        <p className="text-xs text-muted-foreground">
          Checked {formatTime(history.current.checkedAt)}
        </p>
        {history.freshness !== "fresh" ? (
          <p className="text-xs text-amber-400">
            {history.freshness === "stale"
              ? "Stale health observations"
              : "Awaiting first health observation"}
          </p>
        ) : null}
      </div>
      <div className="space-y-2">
        <h3 className="font-medium">30-day uptime</h3>
        <p>
          {history.summary.uptimePercent === null
            ? "No measured uptime"
            : `${history.summary.uptimePercent.toFixed(2)}%`}
        </p>
        <p className="text-xs text-muted-foreground">
          {history.summary.coveragePercent.toFixed(2)}% observed ·{" "}
          {durationLabel(history.summary.downMs)} down · {durationLabel(history.summary.unknownMs)}{" "}
          unknown
        </p>
      </div>
      <div className="space-y-2">
        <h3 className="font-medium">Last 14 days</h3>
        <HealthHistory days={history.days.slice(-14)} />
        {history.days.length === 0 ? (
          <p className="text-xs text-muted-foreground">No daily observations recorded.</p>
        ) : null}
      </div>
      <div className="space-y-2">
        <h3 className="font-medium">Recent checks</h3>
        <Table className="table-fixed [&_th]:truncate [&_th]:text-xs [&_td]:truncate">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[45%]" title="Checked">
                Checked
              </TableHead>
              <TableHead className="w-[35%]" title="Result">
                Result
              </TableHead>
              <TableHead className="w-[20%]" title="Latency">
                Latency
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...history.recent]
              .sort((a, b) => b.checkedAt - a.checkedAt)
              .map((probe) => (
                <TableRow key={probe.checkedAt}>
                  <TableCell className="truncate text-xs" title={formatTime(probe.checkedAt)}>
                    {formatTime(probe.checkedAt)}
                  </TableCell>
                  <TableCell
                    className={cn("truncate text-xs", probe.state === "down" && "text-destructive")}
                  >
                    {stateLabel[probe.state]}
                  </TableCell>
                  <TableCell
                    className="truncate text-xs text-muted-foreground"
                    title={
                      probe.durationMs == null ? "Latency not measured" : `${probe.durationMs}ms`
                    }
                  >
                    {probe.durationMs == null ? "Unknown" : `${probe.durationMs}ms`}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
        {history.recent.length === 0 ? (
          <p className="text-xs text-muted-foreground">No recent probes recorded.</p>
        ) : null}
      </div>
    </div>
  );
}
