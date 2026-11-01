import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { ApiClientError, type ApiClient } from "@unimatrix/api-client";
import {
  adminDeployStateContract,
  adminDeployAttemptHistoryContract,
  adminDeployDeclarationsContract,
  adminDeployReconciliationContract,
  adminDeployHealthHistoryContract,
  adminDeployAttemptLogsContract,
  adminDeployManualRedeployContract,
  adminDeployRollbackContract,
  type DeployAttemptRecord,
  type DeployDeclaration,
  type DeployHealthHistoryResponse,
  type DeployReconciliationResponse,
  type DeployStateResponse,
} from "@unimatrix/shared";
import { TooltipProvider } from "@unimatrix/ui";
import type * as EditorModule from "@unimatrix/ui/editor";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
const apiClient = { request } as unknown as ApiClient;
vi.mock("@/lib/api-client", () => ({ useApiClient: () => apiClient }));
vi.mock("@unimatrix/ui/editor", async () => ({
  ...(await vi.importActual<typeof EditorModule>("@unimatrix/ui/editor")),
  toast: { success: toastSuccess, error: toastError },
}));
const { DeploysPage } = await import("@/features/deploys/deploys-page");
const { ConfigPanel } = await import("@/features/deploys/config-panel");
const { ReconciliationPanel } = await import("@/features/deploys/reconciliation-panel");
const { AttemptHistory, HealthPanel } = await import("@/features/deploys/history-panels");
const { deployQueryKeys, healthQueryOptions, stateQueryOptions } =
  await import("@/features/deploys/queries");

const id = "00000000-0000-4000-8000-000000000001";
const olderId = "00000000-0000-4000-8000-000000000002";
const requestUuid = "00000000-0000-4000-8000-000000000003";
function attempt(overrides: Partial<DeployAttemptRecord> = {}): DeployAttemptRecord {
  return {
    id,
    app: "api",
    repository: "gwenny/unimatrix-01",
    trigger: "ci",
    reporterId: "ci",
    runId: "123",
    runAttempt: 1,
    requestedAt: 1000,
    deadlineAt: 2000,
    image: {
      repository: "ghcr.io/gwenny/api",
      tag: "release-new",
      commit: "a".repeat(40),
      platform: "linux/amd64",
      digestKind: "manifest",
      digest: `sha256:${"a".repeat(64)}`,
    },
    baseline: { containerId: "b".repeat(64), observedAt: 1000 },
    tagWrite: "acknowledged",
    queue: "acknowledged",
    queueClaimedAt: 1000,
    outcome: "landed",
    correlation: "verified",
    after: null,
    landedAt: 1500,
    lateLandedAt: null,
    ...overrides,
  };
}
function declaration(overrides: Partial<DeployDeclaration> = {}): DeployDeclaration {
  return {
    appDir: "api",
    packageName: "@unimatrix/api",
    kind: "node-api",
    configPath: "apps/api/deploy.config.ts",
    composePath: "infra/docker/api-compose.yaml",
    image: "ghcr.io/gwenny/api",
    containerPort: 3000,
    publicStatus: true,
    healthProbe: { url: "https://api:3000/health", caCertificateEnv: "PROBE_CA" },
    env: [
      { name: "NODE_ENV", source: { kind: "literal", value: "production" } },
      { name: "GENERATED", source: { kind: "generated", name: "port", value: "3000" } },
      { name: "OPTIONAL", source: { kind: "variable", name: "OPTIONAL", required: false } },
      {
        name: "DEFAULT",
        source: {
          kind: "variable",
          name: "DEFAULT",
          required: true,
          defaultValue: "public-default",
        },
      },
      {
        name: "CREDENTIAL",
        source: {
          kind: "secrets-store",
          name: "TOKEN",
          secretName: "platform/api-token",
          required: true,
        },
      },
    ],
    buildArgs: [
      { name: "BUILD_REQUIRED" },
      { name: "BUILD_DEFAULT", defaultValue: "public-build-default" },
    ],
    dockerfileEnv: [{ name: "PORT", value: "3000" }],
    ...overrides,
  };
}
function reconciliation(
  overrides: Partial<DeployReconciliationResponse> = {},
): DeployReconciliationResponse {
  return {
    checkedAt: 2000,
    policy: "scheduled-detection-explicit-apply",
    status: "checked",
    observedAt: 1000,
    nextRunAt: 901000,
    intervalMs: 900000,
    freshness: "stale",
    results: [
      {
        appDir: "api",
        outcome: "diffed",
        diff: {
          appDir: "api",
          verdict: "matched",
          composeId: "compose-api",
          inSync: false,
          envFindings: [
            { key: "CREDENTIAL", state: "missing" },
            { key: "PUBLIC_KEY", state: "build-arg-runtime-copy" },
          ],
          settingFindings: [{ setting: "branch", declared: "main", actual: "other" }],
        },
      },
    ],
    ...overrides,
  };
}
function health(overrides: Partial<DeployHealthHistoryResponse> = {}): DeployHealthHistoryResponse {
  const summary = {
    from: 0,
    to: 2000,
    upMs: 1500,
    downMs: 400,
    unknownMs: 100,
    uptimePercent: 78.95,
    coveragePercent: 95,
  };
  return {
    app: "api",
    current: { app: "api", state: "up", checkedAt: 2000 },
    summary,
    days: [summary],
    recent: [
      { app: "api", checkedAt: 1000, state: "down" },
      { app: "api", checkedAt: 2000, state: "up" },
    ],
    freshness: "fresh",
    ...overrides,
  };
}
let state: DeployStateResponse;
let attempts: DeployAttemptRecord[];
let declarations: DeployDeclaration[];
let reconcile: DeployReconciliationResponse;
let logs: unknown;
let failurePath: string | null;
function mount(node = <DeploysPage />) {
  const root = createRootRoute({ component: () => node });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/secrets", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router as never} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}
function tab(name: string) {
  fireEvent.mouseDown(
    screen.getByRole("tab", { name: name === "Reconcile" ? /^Reconcile/u : name }),
    {
      button: 0,
      ctrlKey: false,
    },
  );
}
async function ready() {
  await screen.findByRole("button", { name: /^Redeploy/u });
  await waitFor(() => {
    expect(screen.queryByText("Loading attempt history…")).not.toBeInTheDocument();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(requestUuid);
  failurePath = null;
  state = {
    checkedAt: 2000,
    apps: [
      {
        appDir: "api",
        publicStatus: true,
        dokployUrl: null,
        domains: null,
        metadataObservedAt: null,
        metadataFreshness: "missing",
        container: {
          appDir: "api",
          kind: "matched",
          observedAt: 2000,
          containerId: "b".repeat(64),
          image: "ghcr.io/gwenny/api:running",
          state: "running",
          status: "Up 2 days",
          containerAgeMs: null,
          name: null,
          startedAt: null,
          health: null,
          imageTag: null,
          commit: null,
          commitSubject: null,
          runtimeMetadataObservedAt: null,
          firstObservedAt: 1000,
          lastRecreatedAt: null,
          freshness: "fresh",
        },
      },
      {
        appDir: "web",
        publicStatus: false,
        dokployUrl: null,
        domains: null,
        metadataObservedAt: null,
        metadataFreshness: "missing",
        container: {
          appDir: "web",
          kind: "unknown",
          reason: "no-match",
          observedAt: null,
          freshness: "missing",
        },
      },
    ],
  };
  attempts = [
    attempt({ outcome: "failed", landedAt: null }),
    attempt({
      id: olderId,
      requestedAt: 500,
      image: { ...attempt().image!, tag: "release-previous" },
    }),
  ];
  declarations = [declaration()];
  reconcile = reconciliation();
  logs = {
    app: "api",
    attemptId: id,
    policy: "recognized-events-only",
    status: "available",
    events: ["deployment-initialized", "deployment-completed", "deployment-failed"],
    withheld: true,
    truncated: true,
  };
  request.mockImplementation(
    (contract: { path: string }, options: { query?: { app?: string }; body?: unknown }) => {
      if (contract.path === failurePath)
        return Promise.reject(new ApiClientError("upstream secret", { status: 403 }));
      if (contract === adminDeployStateContract) return Promise.resolve(state);
      if (contract === adminDeployAttemptHistoryContract) return Promise.resolve({ attempts });
      if (contract === adminDeployDeclarationsContract)
        return Promise.resolve({ apps: declarations });
      if (contract === adminDeployReconciliationContract) return Promise.resolve(reconcile);
      if (contract === adminDeployHealthHistoryContract)
        return Promise.resolve(health({ app: options.query?.app ?? "api" }));
      if (contract === adminDeployAttemptLogsContract) return Promise.resolve(logs);
      if (
        contract === adminDeployManualRedeployContract ||
        contract === adminDeployRollbackContract
      )
        return Promise.resolve(attempt({ outcome: "queued", landedAt: null }));
      throw new Error(`Unexpected contract ${contract.path}`);
    },
  );
});

describe("DeploysPage", () => {
  it("warms unselected service details without fetching logs or restarting on fleet polls", async () => {
    const queryClient = mount();
    await ready();
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith(adminDeployAttemptHistoryContract, {
        query: { app: "web", limit: 100 },
      });
      expect(request).toHaveBeenCalledWith(adminDeployHealthHistoryContract, {
        query: { app: "web" },
      });
    });
    expect(
      request.mock.calls.some(([contract]) => contract === adminDeployAttemptLogsContract),
    ).toBe(false);
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: healthQueryOptions(apiClient, "web").queryKey,
        refetchType: "none",
      });
      queryClient.setQueryData(stateQueryOptions(apiClient).queryKey, {
        ...state,
        checkedAt: 3000,
        apps: [...state.apps].reverse(),
      });
    });
    expect(
      request.mock.calls.filter(
        ([contract, options]) =>
          contract === adminDeployHealthHistoryContract &&
          (options as { query?: { app?: string } }).query?.app === "web",
      ),
    ).toHaveLength(1);
    await act(async () => {
      queryClient.setQueryData(stateQueryOptions(apiClient).queryKey, {
        ...state,
        apps: [...state.apps, { ...state.apps[1]!, appDir: "auth" }],
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith(adminDeployAttemptHistoryContract, {
        query: { app: "auth", limit: 100 },
      });
      expect(request).toHaveBeenCalledWith(adminDeployHealthHistoryContract, {
        query: { app: "auth" },
      });
    });
  });

  it("shows an already-current image without claiming replacement or blocking later requests", async () => {
    const image = attempt().image!;
    attempts = [
      attempt({
        outcome: "already-current",
        tagWrite: null,
        queue: null,
        queueClaimedAt: null,
        after: {
          containerId: "b".repeat(64),
          observedAt: 1000,
          image: {
            repository: image.repository,
            platform: image.platform,
            digestKind: image.digestKind,
            digest: image.digest,
          },
        },
        landedAt: null,
        completedAt: 1500,
      }),
    ];
    logs = {
      app: "api",
      attemptId: id,
      policy: "recognized-events-only",
      status: "unavailable",
      reason: "unassociated",
    };
    mount();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select api" }));
    expect(await screen.findByText("Requested image already running")).toBeInTheDocument();
    expect(screen.queryByText("Container replaced")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Redeploy/u })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Roll back" })).toBeDisabled();
    tab("Deploys");
    expect(screen.getByText("Already current")).toBeInTheDocument();
    tab("Logs");
    expect(
      await screen.findByText("No deployment log is associated with this attempt."),
    ).toBeInTheDocument();
    expect(screen.getByText("Already current")).toBeInTheDocument();
  });

  it("keeps a failed deploy separate from healthy runtime and opens every detail tab", async () => {
    mount();
    await ready();
    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
    expect(request).toHaveBeenCalledWith(adminDeployAttemptHistoryContract, {
      query: { limit: 100, latestPerApp: "true" },
    });
    expect(request).toHaveBeenCalledWith(adminDeployAttemptHistoryContract, {
      query: { app: "api", limit: 100 },
    });
    expect(await screen.findByText("78.95%")).toBeInTheDocument();
    expect(screen.getByText(/ghcr.io\/gwenny\/api:running/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Container details" }));
    expect(
      await screen.findByText(/A changed container ID proves recreation/u),
    ).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    tab("Deploys");
    expect(screen.getByRole("table")).toHaveClass("table-fixed");
    expect(screen.getAllByRole("button", { name: /^Logs for/u })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: /^Logs for/u })[0]!);
    expect(
      await screen.findByRole("log", { name: "Recognized deployment events" }),
    ).toHaveTextContent("Deployment process failed");
    expect(screen.getByText(/Unrecognized output was withheld/u)).toBeInTheDocument();
    expect(screen.getByText(/truncated at the log delivery limit/u)).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(adminDeployAttemptLogsContract, {
      query: { app: "api", attemptId: id },
    });
    tab("Health");
    expect(screen.getByText("30-day uptime")).toBeInTheDocument();
    expect(screen.getByText("Not responding")).toBeInTheDocument();
    tab("Reconcile");
    expect(screen.getByText("2 to resolve")).toBeInTheDocument();
    expect(screen.getByText(/Stale snapshot/u)).toBeInTheDocument();
    expect(screen.getByText(/Dokploy has other/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply/iu })).not.toBeInTheDocument();
    tab("Config");
    expect(screen.getByText("public-default")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open in Secrets" })).toHaveAttribute(
      "href",
      "/secrets",
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reveal|apply|save/iu })).not.toBeInTheDocument();
  });

  it("does not claim never deployed or enable mutations when attempt history is unavailable", async () => {
    failurePath = adminDeployAttemptHistoryContract.path;
    mount();
    expect(await screen.findByText("Attempt history unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Never deployed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Redeploy/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Roll back" })).toBeDisabled();
  });

  it("switches services without reusing the previous declaration or attempts", async () => {
    mount();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select web" }));
    expect(screen.queryByRole("tab", { name: "Reconcile" })).not.toBeInTheDocument();
    expect(await screen.findByText("No deployment yet")).toBeInTheDocument();
    expect(screen.getByText("No container matched")).toBeInTheDocument();
    tab("Deploys");
    expect(screen.getByText("No deployment attempts recorded.")).toBeInTheDocument();
    tab("Logs");
    expect(screen.getByText("No deployment attempts recorded.")).toBeInTheDocument();
    tab("Config");
    expect(screen.getByText("Declaration unavailable.")).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(adminDeployHealthHistoryContract, {
      query: { app: "web" },
    });
  });

  it("refreshes active and warmed reads and reports both success and partial failure", async () => {
    const client = mount();
    await ready();
    const spy = vi.spyOn(client, "invalidateQueries");
    fireEvent.click(screen.getByRole("button", { name: "Refresh deployments" }));
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith("Deployment data refreshed.");
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: deployQueryKeys.all });
    await waitFor(() => {
      expect(
        request.mock.calls.filter(
          ([contract, options]) =>
            contract === adminDeployHealthHistoryContract &&
            (options as { query?: { app?: string } }).query?.app === "web",
        ),
      ).toHaveLength(2);
    });
    failurePath = adminDeployDeclarationsContract.path;
    fireEvent.click(screen.getByRole("button", { name: "Refresh deployments" }));
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Some deployment data could not be refreshed.");
    });
    expect(screen.getByText(/Some details may be unavailable/u)).toBeInTheDocument();
    expect(screen.queryByText("upstream secret")).not.toBeInTheDocument();
  });

  it("records a direct redeploy once and invalidates deployment reads", async () => {
    const client = mount();
    await ready();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.click(screen.getByRole("button", { name: /^Redeploy/u }));
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith(adminDeployManualRedeployContract, {
        body: { app: "api", requestId: requestUuid },
      });
    });
    expect(
      request.mock.calls.filter(([contract]) => contract === adminDeployManualRedeployContract),
    ).toHaveLength(1);
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "deploys"] });
    });
    expect(screen.getByRole("tab", { name: "Deploys" })).toHaveAttribute("data-state", "active");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers only verified prior images in the rollback menu and submits the selected target", async () => {
    mount();
    await ready();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Roll back" }), {
      button: 0,
      ctrlKey: false,
    });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /release-previous/u })).toBeInTheDocument();
    expect(within(menu).queryByText(/release-new/u)).not.toBeInTheDocument();
    expect(
      request.mock.calls.filter(([contract]) => contract === adminDeployRollbackContract),
    ).toHaveLength(0);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /release-previous/u }));
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith(adminDeployRollbackContract, {
        body: { app: "api", requestId: requestUuid, targetAttemptId: olderId },
      });
    });
  });

  it("reports a failed direct mutation without retrying or exposing exception text", async () => {
    failurePath = adminDeployManualRedeployContract.path;
    mount();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /^Redeploy/u }));
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Your account does not have deployment access.");
    });
    expect(
      request.mock.calls.filter(([contract]) => contract === adminDeployManualRedeployContract),
    ).toHaveLength(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("upstream secret")).not.toBeInTheDocument();
  });

  it("disables overlapping and self deployment actions", async () => {
    attempts = [attempt({ outcome: "queued", landedAt: null })];
    state.apps[0]!.appDir = "deploy";
    state.apps[0]!.container.appDir = "deploy";
    mount();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select deploy" }));
    expect(screen.getByRole("button", { name: /^Redeploy/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Roll back" })).toBeDisabled();
    expect(screen.getByText(/require host-local operation/u)).toBeInTheDocument();
  });

  it("disables actions while an earlier request is unresolved", async () => {
    attempts = [attempt({ outcome: "queued", landedAt: null })];
    mount();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select api" }));
    expect(screen.getByRole("button", { name: /^Redeploy/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Roll back" })).toBeDisabled();
  });

  it("reports unavailable deployment state without exposing upstream details", async () => {
    failurePath = adminDeployStateContract.path;
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your account does not have deployment access.",
    );
  });

  it("renders no declared services without offering an action", async () => {
    state.apps = [];
    mount();
    expect(await screen.findByText("No declared deployment services.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Redeploy/u })).not.toBeInTheDocument();
  });

  it("provides safe unavailable logs and allows a failed log read to be retried", async () => {
    logs = {
      app: "api",
      attemptId: id,
      policy: "recognized-events-only",
      status: "unavailable",
      reason: "ambiguous",
    };
    mount();
    await ready();
    tab("Logs");
    expect(
      await screen.findByText("The log source cannot be uniquely associated with this attempt."),
    ).toBeInTheDocument();
    failurePath = adminDeployAttemptLogsContract.path;
    fireEvent.click(screen.getByRole("button", { name: "Refresh deployments" }));
    expect(await screen.findByText("Recorded output could not be loaded.")).toBeInTheDocument();
    failurePath = null;
    logs = {
      app: "api",
      attemptId: id,
      policy: "recognized-events-only",
      status: "available",
      events: [],
      withheld: false,
      truncated: false,
    };
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No recognized events in this log.")).toBeInTheDocument();
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith("Recorded output refreshed.");
    });
  });
});

describe("deployment details", () => {
  it("shows measured probe latency without inventing it for legacy observations", async () => {
    mount(
      <HealthPanel
        history={health({
          recent: [
            { app: "api", state: "up", checkedAt: 1000, durationMs: 17 },
            { app: "api", state: "unknown", checkedAt: 2000 },
          ],
        })}
      />,
    );
    expect(await screen.findByText("17ms")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Response" })).toBeInTheDocument();
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]!).getAllByText("Unknown")).toHaveLength(2);
  });

  it.each(["drift", "unavailable", "not-declared", "in-sync"] as const)(
    "reports %s routing with its declaration source",
    async (status) => {
      const value = reconciliation();
      const result = value.results[0];
      if (result?.outcome !== "diffed" || result.diff.verdict !== "matched")
        throw new Error("Matched fixture required");
      result.diff.routing = {
        sourcePath: "apps/deploy/src/reconcile/routing-policy.ts",
        status,
        expectedHosts: ["api.unimatrix-01.dev"],
        observedHosts: status === "unavailable" ? null : ["other.example.com"],
        missingHosts: ["api.unimatrix-01.dev"],
        unexpectedHosts: ["other.example.com"],
        declaredPort: 3001,
        observedPorts: status === "unavailable" ? null : [8080, null],
        portMismatch: status === "drift",
      };
      mount(<ReconciliationPanel app="api" snapshot={value} />);
      if (status === "drift") {
        expect(await screen.findByText(/api.unimatrix-01.dev/u)).toBeInTheDocument();
        expect(screen.getByText(/8080, unknown/u)).toBeInTheDocument();
      } else if (status === "unavailable") {
        expect(
          await screen.findByText("Routing observations are unavailable or incomplete."),
        ).toBeInTheDocument();
      } else if (status === "not-declared") {
        expect(
          await screen.findByText("No routing policy is declared for this service."),
        ).toBeInTheDocument();
      } else {
        expect(screen.queryByText("Different routing")).not.toBeInTheDocument();
      }
      expect(screen.queryByRole("button", { name: /apply/iu })).not.toBeInTheDocument();
    },
  );

  it("renders empty public declarations without inventing runtime values", async () => {
    mount(
      <ConfigPanel
        declaration={declaration({
          kind: "static-spa",
          publicStatus: false,
          healthProbe: { url: "http://web/" },
          env: [],
          buildArgs: [],
          dockerfileEnv: [],
        })}
      />,
    );
    expect(await screen.findByText("Static site")).toBeInTheDocument();
    expect(screen.getByText("Not listed")).toBeInTheDocument();
    expect(screen.getByText(/No environment variables declared/u)).toBeInTheDocument();
    expect(screen.getByText("No build arguments declared.")).toBeInTheDocument();
    expect(screen.getByText("No Dockerfile environment defaults declared.")).toBeInTheDocument();
  });

  it("does not turn unknown health coverage into measured downtime", async () => {
    const value = health();
    value.summary.uptimePercent = null;
    value.days = [];
    value.recent = [];
    value.freshness = "missing";
    value.current.state = "unknown";
    value.current.checkedAt = null;
    mount(<HealthPanel history={value} />);
    expect(await screen.findByText("Awaiting first probe")).toBeInTheDocument();
    expect(screen.queryByText(/minutes down/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it.each(["missing", "ambiguous"] as const)(
    "explains %s mappings without an apply control",
    async (verdict) => {
      mount(
        <ReconciliationPanel
          app="api"
          snapshot={reconciliation({
            results: [
              {
                appDir: "api",
                outcome: "diffed",
                diff:
                  verdict === "missing"
                    ? { verdict, appDir: "api" }
                    : { verdict, appDir: "api", matchCount: 2 },
              },
            ],
          })}
        />,
      );
      expect(
        await screen.findByText(
          verdict === "missing" ? "Service not created" : /2 services matched this declaration/u,
        ),
      ).toBeInTheDocument();
      expect(screen.getByText(/Detection only/u)).toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    },
  );

  it("shows recreation evidence and late observations in history", async () => {
    const manual = attempt({
      image: null,
      trigger: "manual",
      outcome: "recreated",
      recreatedAt: 1500,
      landedAt: null,
      correlation: "pending",
    });
    mount(
      <AttemptHistory
        attempts={[manual, attempt({ id: olderId, trigger: "rollback", lateLandedAt: 3000 })]}
        onSelect={vi.fn()}
      />,
    );
    expect(await screen.findByText("Current service configuration")).toBeInTheDocument();
    expect(screen.getByText("Recreated · image unverified")).toBeInTheDocument();
    expect(screen.getByText("Deployed late")).toBeInTheDocument();
  });
});
