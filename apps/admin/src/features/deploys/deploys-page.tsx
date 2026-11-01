import { useEffect, useRef, useState } from "react";
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
  RiUploadCloud2Line,
  RiErrorWarningFill,
  RiBox3Line,
  RiServerLine,
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
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  StatusDot,
  toast,
  Badge,
  CardHeader,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
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
  createDeployDetailsPrefetcher,
  type DeployDetailsPrefetcher,
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

interface DeploymentRequest {
  app: string;
  requestId: string;
  targetAttemptId?: string;
}

function isDisconnectError(error: unknown): boolean {
  return (
    (error instanceof ApiClientError &&
      (error.status >= 500 || error.status < 400 || error.status === 408)) ||
    error instanceof TypeError ||
    (error instanceof Error && error.name === "AbortError")
  );
}

const reconnectToastId = "deployment-backend-reconnecting";
const reconnectMessage =
  "Disconnected from deployment backend. Reconnecting and checking requests…";

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
  const [requestState, setRequestState] = useState<
    | { request: DeploymentRequest; uncertain: false }
    | { request: DeploymentRequest; uncertain: true; failedAt: number }
    | null
  >(null);
  const detailPrefetcher = useRef<DeployDetailsPrefetcher | null>(null);
  const appIds = (state.data?.apps ?? [])
    .map((entry) => entry.appDir)
    .sort()
    .join("\n");
  useEffect(() => {
    const prefetcher = createDeployDetailsPrefetcher(queryClient, client);
    detailPrefetcher.current = prefetcher;
    return () => {
      prefetcher.stop();
      detailPrefetcher.current = null;
    };
  }, [client, queryClient]);
  useEffect(() => {
    void detailPrefetcher.current?.prefetch(appIds ? appIds.split("\n") : []);
  }, [appIds, client, queryClient]);
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
  const pending = [
    ...history,
    ...(attempts.data?.attempts ?? []).filter((run) => run.app === appName),
  ].some(hasUnresolvedDeploymentWork);
  const historyReady = selectedHistory.isSuccess && !selectedHistory.isError;
  const targets = rollbackTargets(history);
  const runningTag =
    app?.container.kind === "matched" ? (app.container.imageTag?.split("@")[0] ?? null) : null;
  const uncertainRequest = requestState?.uncertain ? requestState.request : null;
  const recoveryReadSucceeded =
    requestState?.uncertain === true &&
    attempts.isSuccess &&
    !attempts.isFetching &&
    attempts.dataUpdatedAt >= requestState.failedAt;
  const disconnected = [state.error, attempts.error, selectedHistory.error].some(isDisconnectError);
  const reconnecting = disconnected || (uncertainRequest !== null && !recoveryReadSucceeded);
  useEffect(() => {
    if (reconnecting) {
      toast.loading(reconnectMessage, { id: reconnectToastId });
    } else {
      toast.dismiss(reconnectToastId);
    }
  }, [reconnecting]);
  useEffect(
    () => () => {
      toast.dismiss(reconnectToastId);
    },
    [],
  );
  useEffect(() => {
    if (uncertainRequest === null) return;
    const recovered = [
      ...(attempts.data?.attempts ?? []),
      ...(selectedHistory.data?.attempts ?? []),
    ].find(
      (run) => run.app === uncertainRequest.app && run.requestId === uncertainRequest.requestId,
    );
    if (recovered === undefined) return;
    if (appName === recovered.app) {
      setAttemptId(recovered.id);
      setTab("deploys");
    }
    setRequestState(null);
    toast.success("Deployment request recovered. Follow its outcome in Deploys.");
  }, [uncertainRequest, attempts.data, selectedHistory.data, appName]);
  const mutation = useMutation({
    mutationFn: async (request: DeploymentRequest) =>
      request.targetAttemptId
        ? client.request(adminDeployRollbackContract, {
            body: {
              app: request.app,
              requestId: request.requestId,
              targetAttemptId: request.targetAttemptId,
            },
          })
        : client.request(adminDeployManualRedeployContract, {
            body: { app: request.app, requestId: request.requestId },
          }),
    retry: false,
    onMutate: (request) => {
      setRequestState({ request, uncertain: false });
    },
    onSuccess: async (result) => {
      setRequestState(null);
      setAttemptId(result.id);
      setTab("deploys");
      toast.success("Deployment request recorded. Follow its outcome in Deploys.");
      await queryClient.invalidateQueries({ queryKey: deployQueryKeys.all });
      void detailPrefetcher.current?.prefetch(appIds ? appIds.split("\n") : []);
    },
    onError: (error, request) => {
      if (isDisconnectError(error)) {
        toast.loading(reconnectMessage, { id: reconnectToastId });
        setRequestState({ request, uncertain: true, failedAt: Date.now() });
        void queryClient.invalidateQueries({ queryKey: deployQueryKeys.all });
      } else {
        setRequestState(null);
        toast.error(describeDeployError(error));
      }
    },
  });
  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: deployQueryKeys.all });
    await detailPrefetcher.current?.prefetch(appIds ? appIds.split("\n") : []);
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
    state.error ??
    attempts.error ??
    selectedHistory.error ??
    declarations.error ??
    reconciliation.error;
  const actionDisabled =
    !historyReady || pending || mutation.isPending || uncertainRequest !== null;
  const attention = latest && attemptNeedsAttention(latest);
  return (
    <TooltipProvider>
      <div className="relative mx-auto flex min-h-0 w-full flex-1 flex-col">
        {(disconnected || uncertainRequest !== null) && (
          <div
            role="status"
            className="flex shrink-0 flex-wrap items-center gap-2 text-sm text-muted-foreground"
          >
            <p>
              {disconnected
                ? "Disconnected from deployment backend. Reconnecting…"
                : recoveryReadSucceeded
                  ? "Connection restored. Deployment outcome is still unknown."
                  : "Deployment response interrupted. Checking the recorded request…"}
            </p>
            {uncertainRequest && !disconnected && recoveryReadSucceeded && (
              <Button
                size="sm"
                variant="outline"
                disabled={mutation.isPending}
                onClick={() => {
                  mutation.mutate(uncertainRequest);
                }}
              >
                Retry same request
              </Button>
            )}
          </div>
        )}
        {state.isPending ? (
          <p role="status">Loading deployments…</p>
        ) : state.error && !state.data ? (
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
              variant="cards"
              detailScroll="managed"
              listHeader={
                <CardHeader className="flex h-11 shrink-0 flex-row items-center justify-between gap-2 px-3 pt-4 pb-1">
                  <h1 className="text-lg leading-none font-semibold tracking-[-0.03em] text-foreground">
                    Deploys
                  </h1>
                  <Button
                    className="size-6"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Refresh deployments"
                    onClick={() => void refresh()}
                  >
                    <RiRefreshLine aria-hidden="true" className="size-4" />
                  </Button>
                </CardHeader>
              }
              list={
                <nav aria-label="Services" className="pt-2">
                  {apps.map((entry) => {
                    const last = attempts.data?.attempts
                      .filter((run) => run.app === entry.appDir)
                      .sort((a, b) => b.requestedAt - a.requestedAt)[0];
                    const failed = last && attemptNeedsAttention(last);
                    const status = serviceStatus(entry.container);
                    return (
                      <button
                        type="button"
                        key={entry.appDir}
                        onClick={() => {
                          setSelectedApp(entry.appDir);
                          setAttemptId(null);
                        }}
                        disabled={mutation.isPending}
                        aria-label={`Select ${entry.appDir}`}
                        aria-current={entry.appDir === appName ? "true" : undefined}
                        className={`flex w-full items-start gap-2.5 border-l-2 px-3 py-2.5 text-left transition-colors ${entry.appDir === appName ? "border-primary bg-muted/60" : "border-transparent hover:border-border hover:bg-muted/30"}`}
                      >
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex min-w-0 items-center gap-1.5">
                            {failed ? (
                              <RiErrorWarningFill
                                aria-hidden="true"
                                className="size-3.5 shrink-0 text-destructive"
                              />
                            ) : null}
                            <span
                              className={`min-w-0 flex-1 truncate text-sm ${failed ? "font-medium text-destructive" : "text-foreground"}`}
                            >
                              {entry.appDir}
                            </span>
                            <StatusDot tone={status.tone} label={status.label} />
                          </span>
                          <span className="flex min-w-0 items-center justify-between gap-2 font-mono text-xs text-muted-foreground">
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
                                : "no container"}
                            </span>
                            {entry.container.kind === "matched" ? (
                              <span className="flex shrink-0 items-center gap-1">
                                <RiTimeLine aria-hidden="true" className="size-3" />
                                {uptimeLabel(entry.container.startedAt)}
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </nav>
              }
              detail={
                <>
                  <div
                    data-service-header
                    className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1"
                  >
                    <h2 className="flex items-center gap-2 text-lg leading-tight font-medium tracking-[-0.03em] text-foreground">
                      <StatusDot
                        tone={serviceStatus(app.container).tone}
                        label={serviceStatus(app.container).label}
                      />
                      {attention ? (
                        <RiErrorWarningFill
                          aria-hidden="true"
                          className="size-4 text-destructive"
                        />
                      ) : null}
                      <span className={attention ? "text-destructive" : undefined}>{appName}</span>
                    </h2>
                    <div className="flex items-center gap-2">
                      <Button
                        aria-label={`Redeploy ${shortTag(runningTag)}`}
                        title={`Redeploy ${shortTag(runningTag)}`}
                        className="size-8 px-0 sm:h-8 sm:w-auto sm:gap-2 sm:px-2.5"
                        size="sm"
                        variant="outline"
                        disabled={actionDisabled}
                        onClick={() => {
                          mutation.mutate({ app: appName, requestId: crypto.randomUUID() });
                        }}
                      >
                        <RiRefreshLine aria-hidden="true" className="size-4" />
                        <span className="hidden sm:inline">Redeploy {shortTag(runningTag)}</span>
                      </Button>
                      <DropdownMenu>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              className="inline-flex"
                              tabIndex={appName === "deploy" ? 0 : undefined}
                              aria-label={
                                appName === "deploy" ? "Why rollback is unavailable" : undefined
                              }
                            >
                              <DropdownMenuTrigger asChild>
                                <Button
                                  aria-label="Roll back"
                                  title={appName === "deploy" ? undefined : "Roll back"}
                                  className="size-8 px-0 sm:h-8 sm:w-auto sm:gap-2 sm:px-2.5"
                                  size="sm"
                                  variant="outline"
                                  disabled={
                                    actionDisabled ||
                                    appName === "deploy" ||
                                    !targets.some((run) => run.image?.tag !== runningTag)
                                  }
                                >
                                  <RiArrowGoBackLine aria-hidden="true" className="size-4" />
                                  <span className="hidden sm:inline">Roll back</span>
                                </Button>
                              </DropdownMenuTrigger>
                            </span>
                          </TooltipTrigger>
                          {appName === "deploy" && (
                            <TooltipContent sideOffset={6}>
                              Rollback of the deploy service requires host-local operation.
                            </TooltipContent>
                          )}
                        </Tooltip>
                        <DropdownMenuContent align="end" className="w-80">
                          <DropdownMenuLabel>
                            Running: {shortTag(runningTag)} · choose a previous deploy
                          </DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          {targets.map((run) => (
                            <DropdownMenuItem
                              key={run.id}
                              disabled={
                                run.image?.tag === runningTag ||
                                actionDisabled ||
                                appName === "deploy"
                              }
                              onSelect={() => {
                                mutation.mutate({
                                  app: appName,
                                  requestId: crypto.randomUUID(),
                                  targetAttemptId: run.id,
                                });
                              }}
                            >
                              <span className="flex min-w-0 flex-col">
                                <span className="font-mono text-xs">
                                  {shortTag(run.image?.tag)}
                                  {run.image?.tag === runningTag ? " · running now" : ""}
                                </span>
                                <span className="truncate text-xs text-muted-foreground">
                                  {run.commitSubject ?? "Commit subject unavailable"}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {uptimeLabel(run.requestedAt)} ago · {formatTime(run.requestedAt)}
                                </span>
                              </span>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      {app.dokployUrl && (
                        <Button
                          className="size-8 px-0 sm:h-8 sm:w-auto sm:gap-2 sm:px-2.5"
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
                            <RiExternalLinkLine aria-hidden="true" className="size-4" />
                          </a>
                        </Button>
                      )}
                    </div>
                    <div
                      data-service-metadata
                      className="col-span-2 grid min-h-11 items-start gap-y-1 text-sm leading-5 text-muted-foreground sm:flex sm:min-h-5 sm:items-center sm:gap-x-3"
                    >
                      <span className="inline-flex h-5 items-center gap-1.5">
                        {app.container.kind === "matched" ? (
                          <RiTimeLine aria-hidden="true" className="size-3.5" />
                        ) : (
                          <RiBox3Line aria-hidden="true" className="size-3.5" />
                        )}
                        {app.container.kind === "matched"
                          ? uptimeLabel(app.container.startedAt)
                          : "No container"}
                      </span>
                      <span aria-hidden="true" className="hidden sm:inline">
                        ·
                      </span>
                      <span className="inline-flex h-5 items-center gap-1.5">
                        {app.domains?.length ? (
                          <RiGlobalLine aria-hidden="true" className="size-3.5" />
                        ) : (
                          <RiServerLine aria-hidden="true" className="size-3.5" />
                        )}
                        {app.domains == null ? (
                          "Domain unknown"
                        ) : app.domains[0] ? (
                          <a
                            className="inline-flex items-center gap-1 text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
                            target="_blank"
                            rel="noreferrer"
                            href={`${app.domains[0].https ? "https" : "http"}://${app.domains[0].host}${app.domains[0].path ?? "/"}`}
                          >
                            {app.domains[0].host}
                            <RiExternalLinkLine aria-hidden="true" className="size-3" />
                          </a>
                        ) : (
                          "Internal service"
                        )}
                      </span>
                    </div>
                  </div>
                  <Tabs value={activeTab} onValueChange={setTab} className="min-h-0 min-w-0 flex-1">
                    <ScrollArea
                      variant="overlay"
                      orientation="horizontal"
                      className="h-11 shrink-0"
                    >
                      <div
                        data-deploy-tab-scroll
                        className="min-w-0 shrink-0 scroll-px-1 p-1"
                        onFocusCapture={(event) => {
                          const target = event.target as HTMLElement;
                          if (target.getAttribute("role") === "tab")
                            target.scrollIntoView({
                              block: "nearest",
                              inline: "nearest",
                              behavior: "instant",
                            });
                        }}
                      >
                        <TabsList
                          variant="line"
                          className="w-full min-w-max shrink-0 justify-start"
                        >
                          {[
                            ["overview", "Overview", RiDashboardLine],
                            ["deploys", "Deploys", RiUploadCloud2Line],
                            ["logs", "Logs", RiTerminalBoxLine],
                            ["health", "Health", RiPulseLine],
                            ...(summary?.showDetail
                              ? [["reconcile", "Reconcile", RiScales3Line] as const]
                              : []),
                            ["config", "Config", RiSettings3Line],
                          ].map(([value, label, Icon]) => (
                            <TabsTrigger key={String(value)} value={String(value)}>
                              <Icon aria-hidden="true" className="size-4" />
                              {String(label)}
                              {value === "reconcile" && summary && summary.count > 0 ? (
                                <Badge variant="destructive">{summary.count}</Badge>
                              ) : null}
                            </TabsTrigger>
                          ))}
                        </TabsList>
                      </div>
                    </ScrollArea>
                    <TabsContent
                      value={activeTab}
                      className="flex min-h-0 flex-1 flex-col overflow-hidden"
                    >
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
                          <div className={activeTab === "overview" ? "h-full p-1" : "p-1"}>
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
                                <AttemptHistory
                                  attempts={history}
                                  onSelect={openAttempt}
                                  runningTag={runningTag}
                                />
                              ))}
                            {activeTab === "health" &&
                              (health.data ? (
                                <HealthPanel
                                  history={health.data}
                                  {...(declaration ? { declaration } : {})}
                                  service={app}
                                />
                              ) : (
                                <p>Health history unavailable.</p>
                              ))}
                            {activeTab === "reconcile" && reconciliation.data && (
                              <ReconciliationPanel
                                snapshot={reconciliation.data}
                                app={appName}
                                declaration={declaration}
                                dokployUrl={app.dokployUrl}
                              />
                            )}
                            {activeTab === "config" &&
                              (declaration ? (
                                <ConfigPanel
                                  declaration={declaration}
                                  service={app}
                                  {...(reconciliation.data
                                    ? { reconciliation: reconciliation.data }
                                    : {})}
                                />
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
      </div>
    </TooltipProvider>
  );
}
