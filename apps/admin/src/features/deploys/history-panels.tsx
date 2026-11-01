import { RiPulseLine, RiTerminalBoxLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import {
  adminDeployAttemptLogsContract,
  type DeployAttemptRecord,
  type DeployHealthHistoryResponse,
  type DeployDeclaration,
  type DeployStateResponse,
} from "@unimatrix/shared";
import { HealthHistory } from "@unimatrix/ui";
import {
  Button,
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
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

import { DeclarationRow } from "./config-panel";

import {
  attemptNeedsAttention,
  durationLabel,
  formatTime,
  outcomeLabel,
  shortTag,
} from "./presentation";

type AttemptHistoryProps = {
  attempts: DeployAttemptRecord[];
  onSelect: (id: string) => void;
  runningTag?: string | null;
};

function attemptTag(attempt: DeployAttemptRecord): string {
  return attempt.image ? shortTag(attempt.image.tag) : "Current service configuration";
}

function formatTimestamp(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function relativeTime(at: number): string {
  const minutes = Math.floor(Math.max(0, Date.now() - at) / 60_000);
  if (minutes < 1) return "< 1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
function completionTime(attempt: DeployAttemptRecord): number | null {
  return attempt.completedAt ?? attempt.landedAt ?? attempt.recreatedAt ?? null;
}
function attemptTone(attempt: DeployAttemptRecord): string {
  return attemptNeedsAttention(attempt)
    ? "text-destructive"
    : attempt.outcome === "landed"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-muted-foreground";
}

export function AttemptHistory({ attempts, onSelect, runningTag }: AttemptHistoryProps) {
  if (attempts.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No deployment attempts recorded.</p>;
  }

  return (
    <Table className="table-fixed [&_th]:truncate [&_td]:truncate">
      <TableHeader>
        <TableRow>
          <TableHead className="w-[42%]" title="Tag">
            Tag
          </TableHead>
          <TableHead className="w-[18%]" title="Requested">
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
              <TableCell>
                <span className="block truncate font-mono text-xs" title={attemptTag(attempt)}>
                  {attemptTag(attempt)}
                  {runningTag != null && runningTag === attempt.image?.tag ? " · running now" : ""}
                </span>
                {attempt.commitSubject && (
                  <span
                    className="block truncate text-xs text-muted-foreground"
                    title={attempt.commitSubject}
                  >
                    {attempt.commitSubject}
                  </span>
                )}
              </TableCell>
              <TableCell className="truncate text-xs" title={formatTime(attempt.requestedAt)}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0}>{relativeTime(attempt.requestedAt)} ago</span>
                  </TooltipTrigger>
                  <TooltipContent>{formatTime(attempt.requestedAt)}</TooltipContent>
                </Tooltip>
              </TableCell>
              <TableCell
                className={cn("truncate text-xs", attemptTone(attempt))}
                title={outcomeLabel(attempt)}
              >
                {outcomeLabel(attempt)}
              </TableCell>
              <TableCell className="truncate font-mono text-xs whitespace-nowrap text-muted-foreground">
                {completedAt === null ? "—" : durationLabel(completedAt - attempt.requestedAt)}
              </TableCell>
              <TableCell className="text-right whitespace-nowrap">
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
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      attemptNeedsAttention(candidate)
                        ? "bg-destructive"
                        : candidate.outcome === "landed"
                          ? "bg-emerald-500"
                          : "bg-muted-foreground",
                    )}
                  />
                  {attemptTag(candidate)} · {formatTimestamp(candidate.requestedAt)}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className={cn("text-xs", attemptTone(attempt))}>{outcomeLabel(attempt)}</span>
      </div>
      <ScrollArea
        variant="overlay"
        className="min-h-0 flex-1 bg-black/25"
        viewportProps={{ "aria-label": "Recorded deployment output", tabIndex: 0 }}
      >
        <div className="px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
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
            <div role="log" aria-label="Deployment diagnostics" className="font-mono">
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
              <div className="font-mono" role="log" aria-label="Recognized deployment events">
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

export function HealthPanel({
  history,
  declaration,
  service,
}: {
  history: DeployHealthHistoryResponse;
  declaration?: DeployDeclaration;
  service?: DeployStateResponse["apps"][number];
}) {
  const stateLabel = { up: "Responding", down: "Not responding", unknown: "Unknown" };
  const path = declaration ? new URL(declaration.healthProbe.url).pathname : null;
  if (history.current.checkedAt === null)
    return (
      <Empty className="min-h-64 border p-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RiPulseLine />
          </EmptyMedia>
          <EmptyTitle>Awaiting first probe</EmptyTitle>
          <EmptyDescription>
            The first result{" "}
            {path ? (
              <>
                for <span className="font-mono text-xs">{path}</span>{" "}
              </>
            ) : null}
            appears when a check runs.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <div className="space-y-5">
      <div>
        <DeclarationRow label="Last check">
          {stateLabel[history.current.state]}
          <span className="text-muted-foreground">
            {" "}
            · checked {relativeTime(history.current.checkedAt)} ago
            {path ? (
              <>
                {" "}
                · <span className="font-mono text-xs">{path}</span> over the internal network
              </>
            ) : null}
            {history.freshness === "stale" ? " · stale observation" : ""}
          </span>
        </DeclarationRow>
        <DeclarationRow label="30-day uptime">
          {history.summary.uptimePercent === null
            ? "No measured uptime"
            : `${history.summary.uptimePercent.toFixed(2)}%`}
          <span className="text-muted-foreground">
            {" "}
            · {Math.round(history.summary.downMs / 60_000)} minutes down
            {history.summary.coveragePercent < 100
              ? ` · ${history.summary.coveragePercent.toFixed(2)}% observed · ${durationLabel(history.summary.unknownMs)} unknown`
              : ""}
          </span>
        </DeclarationRow>
        <DeclarationRow label="Container">
          {service?.container.kind === "matched" ? (
            service.container.status
          ) : (
            <span className="text-muted-foreground">unknown</span>
          )}
        </DeclarationRow>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">Last 14 days</p>
        <HealthHistory days={history.days.slice(-14)} />
        {history.days.length === 0 ? (
          <p className="text-xs text-muted-foreground">No daily observations recorded.</p>
        ) : null}
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">Recent checks</p>
        <Table className="table-fixed [&_th]:truncate [&_td]:truncate">
          <TableHeader>
            <TableRow>
              <TableHead className="w-56">Checked</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Response</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...history.recent]
              .sort((a, b) => b.checkedAt - a.checkedAt)
              .map((probe) => (
                <TableRow key={probe.checkedAt}>
                  <TableCell
                    className="text-xs whitespace-nowrap"
                    title={formatTime(probe.checkedAt)}
                  >
                    {relativeTime(probe.checkedAt)} ago
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-xs",
                      probe.state === "up"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : probe.state === "down"
                          ? "text-destructive"
                          : "text-muted-foreground",
                    )}
                  >
                    {stateLabel[probe.state]}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
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
