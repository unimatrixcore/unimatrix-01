import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiClientError } from "@unimatrix/api-client";
import { ToolMasterDetail } from "@unimatrix/chrome/tool";
import {
  adminDeployManualRedeployContract,
  adminDeployRollbackContract,
  hasUnresolvedDeploymentWork,
  type DeployAttemptRecord,
} from "@unimatrix/shared";
import {
  RiRefreshLine,
  RiPulseLine,
  RiSettings3Line,
  RiTerminalBoxLine,
  RiHistoryLine,
  RiDashboardLine,
  RiScales3Line,
  RiArrowGoBackLine,
  RiExternalLinkLine,
  RiTimeLine,
  RiGlobalLine,
} from "@remixicon/react";
import {
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  TooltipProvider,
  StatusDot,
  toast,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@unimatrix/ui/editor";
import { ScrollArea } from "@unimatrix/ui/scroll-area";
import { useApiClient } from "@/lib/api-client";
import {
  stateQueryOptions,
  attemptsQueryOptions,
  declarationsQueryOptions,
  reconciliationQueryOptions,
  healthQueryOptions,
  historyQueryOptions,
  deployQueryKeys,
} from "./queries";
import {
  attemptNeedsAttention,
  formatTime,
  reconciliationSummary,
  serviceStatus,
  uptimeLabel,
  shortTag,
} from "./presentation";
import { ConfigPanel } from "./config-panel";
import { ReconciliationPanel } from "./reconciliation-panel";
import { AttemptHistory, AttemptLogs, HealthPanel } from "./history-panels";
import { Overview } from "./overview";

export function describeDeployError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return "Your session has expired. Sign in again.";
    if (error.status === 403) return "Your account does not have deployment access.";
    if (error.status === 409)
      return "Deployment request conflicts with deployment policy or pending work. Refresh before trying again.";
    if (error.status === 502) return "The deployment service is unavailable.";
    if (error.status === 404)
      return "Deployment data is unavailable. Check the API deployment configuration.";
  }
  return "The request could not be completed. Refresh to check the latest state.";
}

export function rollbackTargets(attempts: DeployAttemptRecord[]): DeployAttemptRecord[] {
  return attempts.filter(
    (attempt) =>
      attempt.outcome === "landed" &&
      attempt.correlation === "verified" &&
      attempt.landedAt !== null &&
      attempt.image !== null,
  );
}

export function DeploysPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const state = useQuery(stateQueryOptions(client));
  const attempts = useQuery(attemptsQueryOptions(client));
  const declarations = useQuery(declarationsQueryOptions(client));
  const reconciliation = useQuery(reconciliationQueryOptions(client));
  const [selectedApp, setSelectedApp] = useState<string | null>(null);
  const [tab, setTab] = useState("overview");
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [action, setAction] = useState<"redeploy" | "rollback" | null>(null);
  const [targetId, setTargetId] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const apps = [...(state.data?.apps ?? [])].sort((a, b) => {
    const rank = (app: typeof a) => {
      const latest = attempts.data?.attempts
        .filter((run) => run.app === app.appDir)
        .sort((x, y) => y.requestedAt - x.requestedAt)[0];
      return latest && attemptNeedsAttention(latest) ? 0 : app.container.kind === "unknown" ? 1 : 2;
    };
    return (
      rank(a) - rank(b) ||
      (b.container.kind === "matched" ? (b.container.startedAt ?? 0) : 0) -
        (a.container.kind === "matched" ? (a.container.startedAt ?? 0) : 0) ||
      a.appDir.localeCompare(b.appDir)
    );
  });
  const app = apps.find((entry) => entry.appDir === selectedApp) ?? apps[0];
  const appName = app?.appDir ?? "";
  useEffect(() => {
    if (selectedApp === null && !attempts.isPending && appName) setSelectedApp(appName);
  }, [selectedApp, attempts.isPending, appName]);
  const health = useQuery({ ...healthQueryOptions(client, appName), enabled: !!app });
  const selectedHistory = useQuery(historyQueryOptions(client, appName));
  const history = (selectedHistory.data?.attempts ?? [])
    .filter((run) => run.app === appName)
    .sort((a, b) => b.requestedAt - a.requestedAt);
  const latest = history[0];
  const declaration = declarations.data?.apps.find((entry) => entry.appDir === appName);
  const summary = reconciliation.data ? reconciliationSummary(reconciliation.data, appName) : null;
  const activeTab = tab === "reconcile" && !summary?.showDetail ? "overview" : tab;
  const pending = history.some(hasUnresolvedDeploymentWork);
  const historyReady = selectedHistory.isSuccess && !selectedHistory.isError;
  const targets = rollbackTargets(history).filter(
    (run) => app?.container.kind !== "matched" || run.image?.tag !== app.container.imageTag,
  );
  const mutation = useMutation({
    mutationFn: async () =>
      action === "rollback"
        ? client.request(adminDeployRollbackContract, {
            body: { app: appName, requestId, targetAttemptId: targetId },
          })
        : client.request(adminDeployManualRedeployContract, { body: { app: appName, requestId } }),
    retry: false,
    onSuccess: async (result) => {
      setAction(null);
      setAttemptId(result.id);
      setTab("deploys");
      toast.success("Deployment request recorded. Follow its outcome in Deploys.");
      await queryClient.invalidateQueries({ queryKey: deployQueryKeys.all });
    },
    onError: (error) => toast.error(describeDeployError(error)),
  });
  async function refresh() {
    await queryClient.refetchQueries({ queryKey: deployQueryKeys.all, type: "active" });
    const failed = queryClient
      .getQueriesData({ queryKey: deployQueryKeys.all })
      .some(([key]) => queryClient.getQueryState(key)?.status === "error");
    if (failed) toast.error("Some deployment data could not be refreshed.");
    else toast.success("Deployment data refreshed.");
  }
  function openAttempt(id: string) {
    setAttemptId(id);
    setTab("logs");
  }
  const partialError =
    attempts.error ?? selectedHistory.error ?? declarations.error ?? reconciliation.error;
  return (
    <TooltipProvider>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
        <header className="flex shrink-0 items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh deployments"
            onClick={() => void refresh()}
          >
            <RiRefreshLine className="size-4" />
          </Button>
          <h1 className="text-xl font-semibold">Deploys</h1>
        </header>
        {state.isPending ? (
          <p role="status">Loading deployments…</p>
        ) : state.error ? (
          <p role="alert">{describeDeployError(state.error)}</p>
        ) : !app ? (
          <p>No declared deployment services.</p>
        ) : (
          <>
            {(partialError || health.error) && (
              <p role="alert" className="shrink-0 text-sm text-destructive">
                {describeDeployError(partialError ?? health.error)} Some details may be unavailable.
              </p>
            )}
            <ToolMasterDetail
              detailScroll="managed"
              listHeader={
                <h2 className="pb-3 text-xs font-bold uppercase text-muted-foreground">Services</h2>
              }
              list={
                <div className="space-y-1">
                  {apps.map((entry) => {
                    const last = attempts.data?.attempts
                      .filter((run) => run.app === entry.appDir)
                      .sort((a, b) => b.requestedAt - a.requestedAt)[0];
                    return (
                      <button
                        type="button"
                        key={entry.appDir}
                        onClick={() => {
                          setSelectedApp(entry.appDir);
                          setAttemptId(null);
                          setAction(null);
                        }}
                        disabled={mutation.isPending}
                        aria-label={`Select ${entry.appDir}`}
                        aria-pressed={entry.appDir === appName}
                        className={`flex w-full items-center gap-3 border-l-2 px-3 py-3 text-left text-sm ${entry.appDir === appName ? "border-primary bg-muted" : "border-transparent hover:bg-muted/50"}`}
                      >
                        <StatusDot
                          tone={serviceStatus(entry.container).tone}
                          label={serviceStatus(entry.container).label}
                        />
                        <span className="min-w-0 flex-1">
                          <span
                            className={`block ${last && attemptNeedsAttention(last) ? "text-destructive" : ""}`}
                          >
                            {last && attemptNeedsAttention(last) ? "⚠ " : ""}
                            {entry.appDir}
                          </span>
                          <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                            <span
                              className="truncate"
                              title={
                                entry.container.kind === "matched"
                                  ? (entry.container.imageTag ?? undefined)
                                  : undefined
                              }
                            >
                              {entry.container.kind === "matched"
                                ? shortTag(entry.container.imageTag)
                                : "No container"}
                            </span>
                            <span>·</span>
                            <span>
                              {entry.container.kind === "matched"
                                ? uptimeLabel(entry.container.startedAt)
                                : "Unknown"}
                            </span>
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              }
              detail={
                <>
                  <header className="grid h-20 shrink-0 grid-cols-[minmax(0,1fr)_auto] content-center items-center gap-x-2 border-b sm:h-14">
                    <h2
                      className={`flex min-w-0 items-center gap-2 font-semibold ${latest && attemptNeedsAttention(latest) ? "text-destructive" : ""}`}
                    >
                      <StatusDot
                        tone={serviceStatus(app.container).tone}
                        label={serviceStatus(app.container).label}
                      />
                      {latest && attemptNeedsAttention(latest) ? "⚠ " : ""}
                      {appName}
                    </h2>
                    <div className="flex gap-2">
                      <Button
                        aria-label="Redeploy"
                        title="Redeploy"
                        className="size-8 px-0 sm:w-auto sm:gap-2 sm:px-2.5"
                        size="sm"
                        variant="outline"
                        disabled={
                          !historyReady || pending || appName === "deploy" || mutation.isPending
                        }
                        onClick={() => {
                          setSelectedApp(appName);
                          setRequestId(crypto.randomUUID());
                          setAction("redeploy");
                        }}
                      >
                        <RiRefreshLine className="size-4" />
                        <span className="hidden sm:inline">Redeploy</span>
                      </Button>
                      <Button
                        aria-label="Roll back"
                        title="Roll back"
                        className="size-8 px-0 sm:w-auto sm:gap-2 sm:px-2.5"
                        size="sm"
                        variant="outline"
                        disabled={
                          !historyReady ||
                          pending ||
                          appName === "deploy" ||
                          !targets.length ||
                          mutation.isPending
                        }
                        onClick={() => {
                          setTargetId(targets[0]?.id ?? "");
                          setSelectedApp(appName);
                          setRequestId(crypto.randomUUID());
                          setAction("rollback");
                        }}
                      >
                        <RiArrowGoBackLine className="size-4" />
                        <span className="hidden sm:inline">Roll back</span>
                      </Button>
                      {app.dokployUrl && (
                        <Button
                          className="size-8 px-0 sm:w-auto sm:gap-2 sm:px-2.5"
                          size="sm"
                          variant="outline"
                          asChild
                        >
                          <a
                            aria-label="Open in Dokploy"
                            title="Open in Dokploy"
                            href={app.dokployUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <span className="hidden sm:inline">Open in Dokploy</span>
                            <RiExternalLinkLine className="size-4" />
                          </a>
                        </Button>
                      )}
                    </div>
                    <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <RiTimeLine className="size-3.5" />
                        {app.container.kind === "matched"
                          ? uptimeLabel(app.container.startedAt)
                          : "No container"}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <RiGlobalLine className="size-3.5 shrink-0" />
                        {app.domains == null ? (
                          "Domain unknown"
                        ) : app.domains[0] ? (
                          <a
                            className="truncate underline underline-offset-4"
                            target="_blank"
                            rel="noreferrer"
                            href={`${app.domains[0].https ? "https" : "http"}://${app.domains[0].host}${app.domains[0].path ?? "/"}`}
                          >
                            {app.domains[0].host} ↗
                          </a>
                        ) : (
                          "Internal service"
                        )}
                      </span>
                    </div>
                  </header>
                  {appName === "deploy" && (
                    <p className="py-1 text-xs text-muted-foreground">
                      Deploy service actions require host-local operation.
                    </p>
                  )}
                  <Tabs
                    value={activeTab}
                    onValueChange={setTab}
                    className="flex min-h-0 flex-1 flex-col gap-0"
                  >
                    <ScrollArea variant="overlay" orientation="horizontal" className="shrink-0">
                      <TabsList className="h-11 w-max justify-start rounded-none bg-transparent">
                        {[
                          ["overview", "Overview", RiDashboardLine],
                          ["deploys", "Deploys", RiHistoryLine],
                          ["logs", "Logs", RiTerminalBoxLine],
                          ["health", "Health", RiPulseLine],
                          ...(summary?.showDetail
                            ? [["reconcile", "Reconcile", RiScales3Line] as const]
                            : []),
                          ["config", "Config", RiSettings3Line],
                        ].map(([value, label, Icon]) => (
                          <TabsTrigger key={String(value)} value={String(value)} className="gap-2">
                            <Icon className="size-4" />
                            {String(label)}
                            {value === "reconcile" && summary && summary.count > 0 ? (
                              <span className="ml-1 text-xs">{summary.count}</span>
                            ) : null}
                          </TabsTrigger>
                        ))}
                      </TabsList>
                    </ScrollArea>
                    <TabsContent value={activeTab} className="flex min-h-0 flex-1 flex-col">
                      {activeTab === "logs" ? (
                        <AttemptLogs
                          key={appName}
                          app={appName}
                          attempts={history}
                          selectedId={attemptId ?? latest?.id ?? null}
                          onSelect={setAttemptId}
                        />
                      ) : (
                        <ScrollArea variant="overlay" className="min-h-0 flex-1">
                          <div className="p-1 pt-4">
                            {activeTab === "overview" && (
                              <Overview
                                app={app}
                                latest={latest}
                                historyState={
                                  selectedHistory.isPending
                                    ? "loading"
                                    : selectedHistory.isError
                                      ? "unavailable"
                                      : "ready"
                                }
                                attempts={history}
                                health={health.data}
                                reconciliation={reconciliation.data}
                                onTab={setTab}
                                onAttempt={openAttempt}
                              />
                            )}
                            {activeTab === "deploys" &&
                              (selectedHistory.isPending ? (
                                <p>Loading attempts…</p>
                              ) : (
                                <AttemptHistory attempts={history} onSelect={openAttempt} />
                              ))}
                            {activeTab === "health" &&
                              (health.data ? (
                                <HealthPanel history={health.data} />
                              ) : (
                                <p>Health history unavailable.</p>
                              ))}
                            {activeTab === "reconcile" && reconciliation.data && (
                              <ReconciliationPanel
                                snapshot={reconciliation.data}
                                app={appName}
                                declaration={declaration}
                              />
                            )}
                            {activeTab === "config" &&
                              (declaration ? (
                                <ConfigPanel declaration={declaration} service={app} />
                              ) : (
                                <p>Declaration unavailable.</p>
                              ))}
                          </div>
                        </ScrollArea>
                      )}
                    </TabsContent>
                  </Tabs>
                </>
              }
            />
          </>
        )}
        <Dialog
          open={action !== null}
          onOpenChange={(open) => {
            if (!open && !mutation.isPending) setAction(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {action === "rollback" ? "Roll back" : "Redeploy"} {appName}
              </DialogTitle>
              <DialogDescription>
                {action === "rollback"
                  ? "Deploy a previously verified image. This replaces the running service."
                  : "Recreate the service using its currently configured image. Its image provenance will remain unverified."}
              </DialogDescription>
            </DialogHeader>
            {action === "rollback" && (
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger aria-label="Rollback target" className="w-full min-w-0">
                  <SelectValue className="min-w-0 truncate">
                    {shortTag(targets.find((run) => run.id === targetId)?.image?.tag)} ·{" "}
                    {formatTime(targets.find((run) => run.id === targetId)?.landedAt ?? null)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="max-w-[calc(100vw-2rem)]">
                  {targets.map((run) => (
                    <SelectItem key={run.id} value={run.id}>
                      <span className="flex max-w-72 min-w-0 flex-col">
                        <span className="truncate" title={run.image?.tag}>
                          {shortTag(run.image?.tag)} · {formatTime(run.landedAt)}
                        </span>
                        <span
                          className="truncate text-xs text-muted-foreground"
                          title={run.commitSubject ?? undefined}
                        >
                          {run.commitSubject ?? "Commit subject unavailable"}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={mutation.isPending}
                onClick={() => {
                  setAction(null);
                }}
              >
                Cancel
              </Button>
              <Button
                disabled={mutation.isPending || (action === "rollback" && !targetId)}
                onClick={() => {
                  mutation.mutate();
                }}
              >
                {mutation.isPending ? "Requesting…" : "Confirm"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}
