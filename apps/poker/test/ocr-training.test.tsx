import { act, fireEvent, render, screen, waitFor, cleanup, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OcrTraining } from "../src/collector/ocr_training";
import type { PokerTrainingRun } from "@unimatrix/shared";

const collections = [
  {
    id: "one",
    name: "Collection one",
    archived: false,
    total: 25,
    reviewed: 22,
    eligible: 20,
    names: 8,
    blanks: 2,
    pending: 3,
    blocked: 2,
  },
  { id: "two", name: "Collection two", archived: false },
];
const analysis = {
  ready: true,
  accepted: 20,
  duplicates: 2,
  rejected: 1,
  train: 16,
  validation: 2,
  test: 2,
  names: 8,
  blanks: 2,
  blockers: [],
  exclusions: [{ reason: "unreviewed_pixels", count: 1 }],
  collections,
};
const workers = [
  {
    role: "general",
    host: "local",
    gpu: "RTX 4060",
    state: "training",
    epoch: 3,
    epochs: 6,
    loss: 0.02,
    elapsed_seconds: 125,
    global_step: 30,
    steps_per_epoch: 20,
  },
  { role: "names", host: "unimatrix-01", state: "initializing" },
];
const run = {
  id: "opaque-id",
  version: 1,
  display_name: "Version 1",
  kind: "training",
  created_at: 1794612000000,
  status: "completed",
  stage: "Finished",
  collections: ["one"],
  epochs: 6,
  analysis,
  workers,
  summary: {
    accepted: 20,
    duplicates: 2,
    rejected: 1,
    selected_training: 16,
    inherited_holdouts: 3,
    inherited_blank_controls: 1,
  },
  benchmark: {
    exact_match: 0.95,
    cer: 0.01,
    p95_ms: 8,
    baseline_exact_match: 0.9,
    regressions: 1,
    improved: 3,
    results: ["identity", "jpeg80"].flatMap((condition) =>
      ["all", "name"].flatMap((category) =>
        ["general", "names"].map((role) => ({
          role,
          condition,
          category,
          samples: 10,
          exact_match: 0.95,
          baseline_exact_match: 0.9,
          cer: 0.01,
          p95_ms: 8,
          regressions: 1,
          improved: 3,
          processing_errors: condition === "jpeg80" && role === "names" ? 2 : 0,
        })),
      ),
    ),
  },
};
function fixture(initialRuns: unknown[] = []) {
  let runs = initialRuns;
  let analyses: Record<string, unknown>[] = [];
  const control = {
    failStart: false,
    telemetry: undefined as unknown,
    conditionTelemetry: false,
    holdCondition: "",
    releaseCondition: false,
    failResume: false,
    blocked: false,
    unknown: false,
    hold: false,
    release: false,
    holdAfterAccept: false,
    releaseAccepted: false,
    setupReady: true,
    staleGpu: false,
    checkedAt: null as number | null,
    probeChecking: false,
    remoteReady: true,
    names: 8,
    reserved: 0,
    protocol: "audit-v1",
    sourceRevision: "source-v1",
    analysisPreparing: false,
    dataProgress: { stage: "validating", completed: 12, total: 25 } as NonNullable<
      PokerTrainingRun["data_progress"]
    >,
    holdCancel: false,
    releaseCancel: false,
  };
  const calls: { path: string; options?: RequestInit }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
    await Promise.resolve();
    const path = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ path, ...(options ? { options } : {}) });
    const response = (body: unknown) => new Response(JSON.stringify(body));
    if (path === "/api/datasets")
      return response({
        datasets: [...collections, { id: "old", name: "Archived", archived: true }],
      });
    if (path === "/api/training/probe") return response({ checking: control.probeChecking });
    if (path === "/api/training/analyze") {
      while (control.hold && !control.release)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const body = JSON.parse(typeof options?.body === "string" ? options.body : "{}") as {
        collections: string[];
        epochs: number;
      };
      const result = {
        id: `analysis-${calls.length}`,
        created_at: Date.now(),
        kind: "analysis",
        status: control.analysisPreparing ? "preparing" : "completed",
        stage: "Checked",
        data_progress: control.dataProgress,
        ...body,
        analysis: {
          ...analysis,
          names: control.names,
          reserved: control.reserved,
          collections: collections.map((item) => ({
            ...item,
            reserved: item.id === "one" ? control.reserved : 0,
          })),
          ready: !control.blocked,
          blockers: control.blocked ? ["No verified names."] : [],
        },
      };
      analyses = [result];
      while (control.holdAfterAccept && !control.releaseAccepted)
        await new Promise((resolve) => setTimeout(resolve, 10));
      return response({ run: result });
    }
    if (path.endsWith("/resume")) {
      if (control.failResume)
        return new Response(JSON.stringify({ error: "Checkpoint could not be reopened" }), {
          status: 409,
        });
      runs = [
        {
          ...run,
          status: "training",
          stage: "Resuming from the saved checkpoint",
          can_resume: false,
          benchmark: null,
        },
      ];
      return response({ run: runs[0] });
    }
    if (path.endsWith("/cancel")) {
      const id = path.split("/").at(-2);
      const preparation = analyses.find((item) => item.id === id);
      if (preparation) {
        while (control.holdCancel && !control.releaseCancel)
          await new Promise((resolve) => setTimeout(resolve, 10));
        const stopped = { ...preparation, status: "interrupted", stage: "Stopped" };
        analyses = analyses.map((item) => (item.id === id ? stopped : item));
        return response({ run: stopped });
      }
      runs = [
        {
          ...run,
          status: "interrupted",
          stage: "Stopped",
          error: "Stopped by user.",
          benchmark: null,
        },
      ];
      return response({ run: runs[0] });
    }
    if (options?.method === "POST") {
      if (control.failStart)
        return new Response(JSON.stringify({ error: "Remote GPU disconnected" }), { status: 503 });
      runs = [run];
      return response({ run });
    }
    if (path === "/api/training")
      return response({
        runs,
        analyses: analyses.map((item) => ({
          ...item,
          status:
            item.status === "interrupted"
              ? "interrupted"
              : control.analysisPreparing
                ? "preparing"
                : "completed",
          data_progress: control.dataProgress,
        })),
        analysis_protocol: control.protocol,
        collections: control.unknown
          ? collections.map((item) => ({ id: item.id, name: item.name }))
          : collections.map((collection) => ({ ...collection, revision: control.sourceRevision })),
        setup: {
          ready: control.setupReady,
          error: control.setupReady ? null : "Active baseline unavailable",
        },
        active_release: {
          name: "Active release",
          general_sha256: "a".repeat(64),
          names_sha256: "b".repeat(64),
        },
        gpu_status: {
          checked_at: control.checkedAt ?? Date.now() - (control.staleGpu ? 60000 : 0),
          devices: [
            { host: "local", gpu: "RTX 4060", ready: true },
            {
              host: "unimatrix-01",
              gpu: "RTX 3060",
              ready: control.remoteReady,
              error: control.remoteReady ? null : "Offline",
            },
          ],
        },
      });
    const condition = new URL(path, "http://localhost").searchParams.get("condition") ?? "identity";
    while (control.holdCondition === condition && !control.releaseCondition)
      await new Promise((resolve) => setTimeout(resolve, 10));
    return response({
      telemetry: control.conditionTelemetry
        ? {
            histories: [],
            samples: [],
            benchmark: {
              condition,
              cases: [
                {
                  sample_id: "condition-case",
                  role: "general",
                  category: "amount",
                  condition,
                  label: condition,
                  baseline_prediction: "before",
                  candidate_prediction: condition,
                  baseline_exact: false,
                  candidate_exact: true,
                  image_url: null,
                },
              ],
            },
          }
        : control.telemetry,
      version: {
        id: "opaque-id",
        roles: ["general", "names"],
        dataset_sha256: "d".repeat(64),
        test_sha256: "e".repeat(64),
        artifacts: { general: { "model.onnx": "c".repeat(64) } },
        baseline_artifacts: { general: { "model.onnx": "f".repeat(64) } },
      },
      run: runs[0],
      analysis,
      workers,
      logs: { general: "epoch: [3/6]" },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher, control };
}
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function renderTraining() {
  const view = render(<OcrTraining active />);
  fireEvent.keyDown(screen.getByRole("button", { name: /^Collections ·/ }), { key: "ArrowDown" });
  return view;
}
async function selectReady() {
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Collection one" }));
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Start training" })).toBeEnabled();
  });
}
it("audits selected collections with the default recipe before start, then inspects models, conditions, exclusions and metadata", async () => {
  const { calls } = fixture();
  renderTraining();
  await screen.findByRole("menuitemcheckbox", { name: "Collection one" });
  expect(screen.queryByRole("menuitemcheckbox", { name: "Archived" })).toBeNull();
  await selectReady();
  expect(screen.getByLabelText("Selected data counts")).toHaveTextContent("20 eligible");
  fireEvent.click(screen.getByRole("button", { name: "Start training" }));
  await screen.findByRole("heading", { name: "Version 1" });
  expect(
    calls.find((call) => call.path === "/api/training" && call.options?.method === "POST")?.options
      ?.body,
  ).toBe(JSON.stringify({ collections: ["one"], epochs: 6 }));
  fireEvent.click(screen.getByRole("button", { name: /^Compare stress conditions/ }));
  const benchmark = screen.getByRole("region", { name: "Benchmark comparison" });
  expect(within(benchmark).getAllByText("+5.00 pp")).toHaveLength(2);
  fireEvent.click(within(benchmark).getByRole("button", { name: "JPEG" }));
  fireEvent.change(within(benchmark).getByRole("combobox", { name: "Benchmark category" }), {
    target: { value: "name" },
  });
  expect(within(benchmark).getByRole("combobox", { name: "Benchmark category" })).toHaveValue(
    "name",
  );
  expect(within(benchmark).getByText("2 errors")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Logs" }));
  expect(screen.getByRole("rowheader", { name: "unreviewed pixels" })).toBeTruthy();
  expect(screen.getByText("Inherited holdouts")).toBeTruthy();
  expect(screen.getByText("opaque-id")).toBeTruthy();
  expect(screen.getByText("d".repeat(64))).toBeTruthy();
  expect(screen.getByText("f".repeat(64))).toBeTruthy();
  expect(await screen.findByText("epoch: [3/6]")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "opaque-id" })).toBeNull();
});
it("cancels the active version as a neutral user stop with recorded progress", async () => {
  const { calls } = fixture([{ ...run, status: "training", benchmark: null }]);
  renderTraining();
  expect(await screen.findByRole("button", { name: "Stop" })).toHaveAttribute(
    "data-variant",
    "destructive",
  );
  expect(screen.getByRole("menuitemcheckbox", { name: "Collection one" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(screen.getByRole("menuitemcheckbox", { name: "Collection one" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(screen.getByRole("status")).toHaveTextContent("Training");
  expect(
    within(screen.getByRole("article", { name: "General worker" })).getByText("3 / 6"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => {
    expect(screen.getByRole("menuitemcheckbox", { name: "Collection one" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  expect(
    calls.some(
      (call) => call.path === "/api/training/opaque-id/cancel" && call.options?.method === "POST",
    ),
  ).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: /^Collections · 1/ })).toBeTruthy();
  expect(screen.getByRole("menuitemcheckbox", { name: "Collection one" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});
it("surfaces a start failure and retains the verified selection for retry", async () => {
  const { control } = fixture();
  control.failStart = true;
  renderTraining();
  await selectReady();
  fireEvent.click(screen.getByRole("button", { name: "Start training" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Remote GPU disconnected");
  expect(screen.getByRole("menuitemcheckbox", { name: "Collection one" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(screen.getByRole("button", { name: "Start training" })).toBeEnabled();
});
it("aborts requests and stops background polling after leaving the training tab", async () => {
  const { calls } = fixture([{ ...run, status: "training" }]);
  const view = renderTraining();
  await screen.findByRole("heading", { name: "Version 1" });
  await waitFor(() => {
    expect(calls.some((call) => call.path === "/api/training/opaque-id")).toBe(true);
  });
  const count = calls.length;
  vi.useFakeTimers();
  view.rerender(<OcrTraining active={false} />);
  expect((calls[0]?.options?.signal as AbortSignal).aborted).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(calls).toHaveLength(count);
});
it("shows unknown counts explicitly and blocks data rejected by the automatic audit", async () => {
  const { control } = fixture();
  control.unknown = true;
  control.blocked = true;
  renderTraining();
  await screen.findByRole("menuitemcheckbox", { name: "Collection two" });
  expect(screen.queryByRole("spinbutton")).toBeNull();
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Collection one" }));
  await screen.findByText("No verified names.");
  expect(screen.getByRole("button", { name: "Start training" })).toBeDisabled();
});
it("ignores an audit result that belongs to a selection the user has left", async () => {
  const { control } = fixture();
  control.hold = true;
  renderTraining();
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Collection one" }));
  await screen.findByText("Preparing training data…");
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Collection two" }));
  expect(screen.getByRole("button", { name: "Start training" })).toBeDisabled();
  control.release = true;
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Start training" })).toBeEnabled();
  });
});
it("retains one accepted audit when polling observes it before its POST response arrives", async () => {
  vi.useFakeTimers();
  const { control, calls } = fixture();
  control.analysisPreparing = true;
  control.holdAfterAccept = true;
  control.staleGpu = true;
  control.probeChecking = true;
  renderTraining();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Collection one" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2600);
  });
  expect(calls.filter((call) => call.path === "/api/training/analyze")).toHaveLength(1);
  expect(screen.getByRole("status")).toHaveTextContent("Validating crops");
  control.releaseAccepted = true;
  control.analysisPreparing = false;
  control.staleGpu = false;
  control.probeChecking = false;
  for (let cycle = 0; cycle < 130; cycle++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
  expect(calls.filter((call) => call.path === "/api/training/analyze")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Start training" })).toBeEnabled();
});
it("allows automatic data analysis while the baseline setup blocks training", async () => {
  const { control, calls } = fixture();
  control.setupReady = false;
  renderTraining();
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Collection one" }));
  await waitFor(() => {
    expect(calls.some((call) => call.path === "/api/training/analyze")).toBe(true);
  });
  expect(screen.getByRole("button", { name: "Start training" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Active baseline unavailable");
});
it("keeps checking an in-flight GPU probe even when a prior cached result exists", async () => {
  const { control, calls } = fixture();
  control.staleGpu = true;
  control.probeChecking = true;
  vi.useFakeTimers();
  renderTraining();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const initial = calls.filter((call) => call.path === "/api/training").length;
  control.staleGpu = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(calls.filter((call) => call.path === "/api/training")).toHaveLength(initial + 1);
});
it("keeps measured compute availability visible with version history and enables Start only after the required remote GPU returns", async () => {
  const { control } = fixture([run]);
  control.remoteReady = false;
  vi.useFakeTimers();
  renderTraining();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Collection one" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  const compute = screen.getByRole("group", { name: "Compute availability" });
  expect(
    within(compute).getByRole("img", { name: /unimatrix-01.*Unavailable.*Offline/ }),
  ).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Version 1" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start training" })).toBeDisabled();
  control.remoteReady = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(within(compute).queryByRole("img", { name: /Unavailable/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Start training" })).toBeEnabled();
});
it("requires only the local GPU when the verified selection has no names to train", async () => {
  const { control } = fixture();
  control.remoteReady = false;
  control.names = 0;
  renderTraining();
  await selectReady();
  expect(
    within(screen.getByRole("group", { name: "Compute availability" })).getByRole("img", {
      name: /Unavailable.*Offline/,
    }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start training" })).toBeEnabled();
});
it.each(["protocol", "sourceRevision"] as const)(
  "rechecks unchanged selected collections after %s changes and blocks stale readiness",
  async (changedField) => {
    const { control, calls } = fixture();
    vi.useFakeTimers();
    renderTraining();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Collection one" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByRole("button", { name: "Start training" })).toBeEnabled();
    expect(calls.filter((call) => call.path === "/api/training/analyze")).toHaveLength(1);
    control[changedField] = "changed-v2";
    control.hold = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(screen.getByRole("menuitemcheckbox", { name: "Collection one" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("button", { name: "Start training" })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(calls.filter((call) => call.path === "/api/training/analyze")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Start training" })).toBeDisabled();
    control.release = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(screen.getByRole("button", { name: "Start training" })).toBeEnabled();
  },
);
it("keeps a running check visible when reviewed labels change, then checks the new revision", async () => {
  const { control, calls } = fixture();
  control.analysisPreparing = true;
  vi.useFakeTimers();
  renderTraining();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Collection one" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(screen.getByRole("status")).toHaveTextContent("Validating crops · 12/25");
  control.sourceRevision = "newly-reviewed-labels";
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByRole("status")).toHaveTextContent("Validating crops · 12/25");
  expect(screen.queryByText("Waiting for the previous collection check…")).toBeNull();
  expect(screen.getByRole("button", { name: "Start training" })).toBeDisabled();
  expect(calls.filter((call) => call.path === "/api/training/analyze")).toHaveLength(1);
  control.analysisPreparing = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(calls.filter((call) => call.path === "/api/training/analyze")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Start training" })).toBeEnabled();
  expect(calls.some((call) => call.path.endsWith("/cancel"))).toBe(false);
});

it("shows real preparation operations and only reports counts provided by the worker", async () => {
  const { control } = fixture();
  control.analysisPreparing = true;
  control.dataProgress = { stage: "reading", collection_name: "Collection one" };
  renderTraining();
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Collection one" }));
  await screen.findByText("Reading captures… · Collection one");
  control.dataProgress = { stage: "deduplicating" };
  await waitFor(
    () => expect(screen.getByRole("status")).toHaveTextContent("Removing duplicates…"),
    { timeout: 3000 },
  );
  expect(screen.getByRole("status")).not.toHaveTextContent("12/25");
  control.dataProgress = { stage: "reserving" };
  await waitFor(
    () => expect(screen.getByRole("status")).toHaveTextContent("Reserving benchmark crops…"),
    { timeout: 3000 },
  );
});

it.each(["collections"] as const)(
  "cancels obsolete preparation when %s change and validates the current choice",
  async (change) => {
    const { control, calls } = fixture();
    control.analysisPreparing = true;
    control.holdCancel = true;
    renderTraining();
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Collection one" }));
    await screen.findByText("Validating crops · 12/25");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Collection two" }));
    await screen.findByText("Stopping preparation…");
    expect(calls.filter((call) => call.path.endsWith("/cancel"))).toHaveLength(1);
    expect(calls.filter((call) => call.path === "/api/training/analyze")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Start training" })).toBeDisabled();
    control.analysisPreparing = false;
    control.releaseCancel = true;
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start training" })).toBeEnabled(),
    );
    const requests = calls.filter((call) => call.path === "/api/training/analyze");
    expect(requests).toHaveLength(2);
    const latest = JSON.parse(requests.at(-1)?.options?.body as string) as {
      collections: string[];
      epochs: number;
    };
    expect(latest).toEqual({
      collections: change === "collections" ? ["one", "two"] : ["one"],
      epochs: 6,
    });
    expect(calls.some((call) => call.path === "/api/training/opaque-id/cancel")).toBe(false);
  },
);
it("shows valid held-out crops as reserved without treating them as excluded errors", async () => {
  const { control } = fixture();
  control.reserved = 2;
  renderTraining();
  await selectReady();
  expect(screen.getByLabelText("Selected data counts")).toHaveTextContent(
    "20 eligible2 benchmark crops",
  );

  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Start training" })).toBeEnabled();
});
it("starts a fresh GPU probe when a cached measurement expires rather than thirty seconds after opening the tab", async () => {
  const { control, calls } = fixture();
  control.checkedAt = Date.now() - 25000;
  vi.useFakeTimers();
  renderTraining();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(calls.filter((call) => call.path === "/api/training/probe")).toHaveLength(1);
  control.probeChecking = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(calls.filter((call) => call.path === "/api/training/probe")).toHaveLength(2);
});
it("resumes a failed version in place without requiring a new collection selection", async () => {
  const { calls } = fixture([
    { ...run, status: "failed", stage: "Training failed", can_resume: true },
  ]);
  renderTraining();
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Resume training" })).toBeEnabled();
  });
  expect(screen.queryByRole("button", { name: "Start training" })).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Resume available");
  expect(screen.getByRole("menuitemcheckbox", { name: "Collection one" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Resume training" }));
  await screen.findByRole("button", { name: "Stop" });
  expect(
    calls.some(
      (call) => call.path === "/api/training/opaque-id/resume" && call.options?.method === "POST",
    ),
  ).toBe(true);
  expect(
    calls.some((call) => call.path === "/api/training" && call.options?.method === "POST"),
  ).toBe(false);
  expect(screen.getByRole("heading", { name: "Version 1" })).toBeTruthy();
});
it("keeps the failed version selected and retryable when resume is rejected", async () => {
  const { control } = fixture([
    { ...run, status: "failed", stage: "Training failed", can_resume: true },
  ]);
  control.failResume = true;
  renderTraining();
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Resume training" })).toBeEnabled();
  });
  fireEvent.click(screen.getByRole("button", { name: "Resume training" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Checkpoint could not be reopened");
  expect(screen.getByRole("button", { name: "Resume training" })).toBeEnabled();
});

it("restores collections and the default recipe after remount without automatically starting training", async () => {
  const { calls } = fixture();
  let view = renderTraining();
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Collection one" }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Collection two" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Start training" })).toBeEnabled());
  view.unmount();
  view = renderTraining();
  expect(await screen.findByRole("menuitemcheckbox", { name: "Collection one" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(screen.getByRole("menuitemcheckbox", { name: "Collection two" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(screen.queryByRole("spinbutton")).toBeNull();
  await waitFor(() => expect(screen.getByRole("button", { name: "Start training" })).toBeEnabled());
  expect(
    calls.some((call) => call.path === "/api/training" && call.options?.method === "POST"),
  ).toBe(false);
  expect(JSON.parse(localStorage.getItem("poker-lab:workspace:v1") || "{}")).toMatchObject({
    trainingSelection: { collections: ["one", "two"], epochs: 6 },
  });
  view.unmount();
});
it("filters removed and archived saved selections using the current catalog", async () => {
  fixture();
  localStorage.setItem(
    "poker-lab:workspace:v1",
    JSON.stringify({ trainingSelection: { collections: ["one", "old", "removed"], epochs: 6 } }),
  );
  renderTraining();
  expect(await screen.findByRole("menuitemcheckbox", { name: "Collection one" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await waitFor(() => {
    expect(JSON.parse(localStorage.getItem("poker-lab:workspace:v1") || "{}")).toMatchObject({
      trainingSelection: { collections: ["one"], epochs: 6 },
    });
  });
});

it("explains the Names dependency while the shared base model is training", async () => {
  fixture([
    {
      ...run,
      status: "training",
      stage: "Training shared base model",
      workers: [
        { ...workers[0], stage_id: "base", epoch: 8, epochs: 8 },
        { role: "names", host: "unimatrix-01", state: "waiting", stage_id: "names-base" },
      ],
    },
  ]);
  renderTraining();
  expect(await screen.findByText("Waiting for shared base model")).toBeTruthy();
  expect(screen.getByRole("article", { name: "General worker" })).toHaveTextContent("8 / 8");
  expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
});
it("shows reported waiting reasons and keeps other queued workers distinct from the shared base", async () => {
  const { control } = fixture([
    {
      ...run,
      status: "training",
      workers: [
        { ...workers[0], stage_id: "general" },
        {
          role: "names",
          host: "unimatrix-01",
          state: "waiting",
          stage_id: "names-base",
          waiting_reason: "Connecting to unimatrix-01",
        },
      ],
    },
  ]);
  control.analysisPreparing = false;
  const view = renderTraining();
  expect(await screen.findByText("Connecting to unimatrix-01")).toBeTruthy();
  view.unmount();
  fixture([
    {
      ...run,
      status: "training",
      workers: [
        { ...workers[0], stage_id: "general" },
        { role: "names", host: "unimatrix-01", state: "waiting", stage_id: "names" },
      ],
    },
  ]);
  renderTraining();
  expect(await screen.findByText("Queued", { exact: true })).toBeTruthy();
  expect(screen.queryByText("Waiting for shared base model")).toBeNull();
});

it("keeps the checkpoint dependency explicit after the general worker leaves the base stage", async () => {
  fixture([
    {
      ...run,
      status: "training",
      workers: [
        { ...workers[0], stage_id: "general" },
        { role: "names", host: "unimatrix-01", state: "waiting", stage_id: "names-base" },
      ],
    },
  ]);
  renderTraining();
  expect(await screen.findByText("Waiting for base checkpoint")).toBeTruthy();
  expect(screen.queryByText("Waiting for shared base model")).toBeNull();
});

it("keeps the shared collection multi-select open across keyboard toggles", async () => {
  fixture();
  renderTraining();
  const one = await screen.findByRole("menuitemcheckbox", { name: "Collection one" });
  fireEvent.keyDown(one, { key: "Enter" });
  fireEvent.keyDown(screen.getByRole("menuitemcheckbox", { name: "Collection two" }), {
    key: "Enter",
  });
  expect(screen.getByRole("button", { name: "Collections · 2" })).toBeTruthy();
  expect(one).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("menuitemcheckbox", { name: "Collection two" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});
it("keeps overall readiness beside Start and tooltip-only GPU states on the bottom row", async () => {
  const { control } = fixture();
  control.remoteReady = false;
  renderTraining();
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Collection one" }));
  await screen.findByText("Required GPU unavailable");
  const device = screen.getByRole("img", { name: /unimatrix-01.*Unavailable.*Offline/ });
  expect(device.closest(".training-setup-bottom")).toBeTruthy();
  expect(device.querySelector("svg")).toHaveClass("training-device-bad");
  expect(device).not.toHaveTextContent("Unavailable");
  expect(
    screen.getByRole("img", { name: /^Blocked$/ }).closest(".training-setup-actions"),
  ).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "OCR Training" })).toBeNull();
});
it("ignores malformed optional telemetry while retaining the completed run and benchmark", async () => {
  const { control } = fixture([run]);
  control.telemetry = {
    histories: [{ role: "general", stage_id: "base", points: [{ step: -1, loss: 0.2 }] }],
    samples: [],
  };
  renderTraining();
  expect(await screen.findByRole("heading", { name: "Version 1" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Compare stress conditions/ })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("requests selected completed-run conditions and prevents a late condition response from replacing current evidence", async () => {
  const { control, calls } = fixture([run]);
  control.conditionTelemetry = true;
  control.holdCondition = "jpeg80";
  renderTraining();
  fireEvent.click(await screen.findByRole("button", { name: /^Inspect improvements/ }));
  await screen.findByText("Target · identity");
  fireEvent.change(screen.getByRole("combobox", { name: "Result condition" }), {
    target: { value: "jpeg80" },
  });
  await waitFor(() => {
    expect(calls.some((call) => call.path === "/api/training/opaque-id?condition=jpeg80")).toBe(
      true,
    );
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Result condition" }), {
    target: { value: "identity" },
  });
  await screen.findByText("Target · identity");
  control.releaseCondition = true;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(screen.queryByText("Target · jpeg80")).toBeNull();
  expect(screen.getByRole("combobox", { name: "Result condition" })).toHaveValue("identity");
});
