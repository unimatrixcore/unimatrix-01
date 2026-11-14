import type { ReactNode } from "react";
import { TooltipProvider } from "@unimatrix/ui/editor";
import { fireEvent, render as renderView, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { TrainingActivity, LossHistory } from "../src/collector/training-activity";
import type { PokerTrainingRun, PokerTrainingTelemetry } from "@unimatrix/shared";
const render = (ui: ReactNode) => renderView(ui, { wrapper: TooltipProvider });
const run: PokerTrainingRun = {
  id: "recorded",
  kind: "training",
  created_at: 1,
  status: "training",
  stage: "Training",
  collections: [],
  epochs: 6,
};
const telemetry: PokerTrainingTelemetry = {
  samples: [],
  histories: [
    {
      role: "general",
      stage_id: "base",
      points: [
        { step: 1, loss: 1 },
        { step: 2, loss: 0.5 },
      ],
    },
    {
      role: "general",
      stage_id: "general",
      points: [
        { step: 1, loss: 0.4 },
        { step: 2, loss: 0.3 },
      ],
    },
  ],
  benchmark: {
    pass: "candidate",
    processed: 1,
    total: 2,
    cases: [
      {
        sample_id: "a",
        role: "general",
        category: "amount",
        condition: "identity",
        label: "100",
        baseline_prediction: "100",
        candidate_prediction: "10",
        baseline_exact: true,
        candidate_exact: false,
        image_url: "/api/training/sample?run=recorded&sample_id=a",
      },
      {
        sample_id: "b",
        role: "names",
        category: "name",
        condition: "identity",
        label: "Player 5",
        baseline_prediction: "Player5",
        candidate_prediction: "Player 5",
        baseline_exact: false,
        candidate_exact: true,
        image_url: null,
      },
    ],
  },
};
it("keeps stable worker lanes and distinct recorded loss series across phase resets", () => {
  const view = render(
    <TrainingActivity
      run={run}
      workers={[
        {
          role: "general",
          host: "local",
          state: "training",
          stage_id: "base",
          epoch: 8,
          epochs: 8,
        },
      ]}
      telemetry={telemetry}
    />,
  );
  const lane = screen.getByRole("article", { name: "General worker" });
  expect(within(lane).getAllByRole("img", { name: /recorded loss/ })).toHaveLength(1);
  expect(view.container.querySelectorAll("polyline")).toHaveLength(1);
  expect(within(lane).getByText("8 / 8")).toBeTruthy();
  expect(lane.querySelector("figure")).toHaveAttribute("data-stage", "base");
  view.rerender(
    <TrainingActivity
      run={run}
      workers={[
        {
          role: "general",
          host: "local",
          state: "training",
          stage_id: "general",
          epoch: 1,
          epochs: 4,
        },
      ]}
      telemetry={telemetry}
    />,
  );
  expect(screen.getByRole("article", { name: "General worker" })).toBe(lane);
  expect(within(lane).getByText("1 / 4")).toBeTruthy();
  expect(lane.querySelector("figure")).toHaveAttribute("data-stage", "general");
  expect(view.container.querySelectorAll("polyline")).toHaveLength(1);
});
it("never invents missing history, utilization or batch images", () => {
  render(<TrainingActivity run={run} workers={[]} telemetry={undefined} />);
  expect(screen.getAllByText("Loss appears after the first training measurement.")).toHaveLength(2);
  expect(screen.queryByRole("img", { name: /recorded loss/ })).toBeNull();
  expect(screen.queryByRole("progressbar")).toBeNull();
});
it("shows matching baseline/candidate/target records separately for each model", () => {
  render(
    <TrainingActivity
      run={{ ...run, status: "benchmarking" }}
      workers={[]}
      telemetry={telemetry}
    />,
  );
  const general = screen.getByRole("region", { name: "General benchmark evidence" });
  expect(within(general).getByText("Regressed")).toBeTruthy();
  expect(within(general).getByRole("img", { name: "Frozen crop: 100" })).toHaveAttribute(
    "src",
    "/api/training/sample?run=recorded&sample_id=a",
  );
  expect(within(general).getByText("10")).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Names benchmark evidence" })).getByText("Player 5"),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Regressions" })).toBeNull();
});
it("lets completed versions inspect retained regressions without confusing them with all cases", () => {
  render(
    <TrainingActivity run={{ ...run, status: "completed" }} workers={[]} telemetry={telemetry} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Review regressions/ }));
  expect(screen.getByText("Regressed")).toBeTruthy();
  expect(screen.queryByText("Improved")).toBeNull();
  expect(screen.getByText("No matching paired examples retained.")).toBeTruthy();
});
it("groups four genuine preparation crops by exact collection identity and never guesses missing attribution", () => {
  render(
    <TrainingActivity
      run={{
        ...run,
        collections: ["one", "two"],
        status: "preparing",
        analysis: {
          ready: true,
          blockers: [],
          collections: [
            { id: "one", name: "First", eligible: 10 },
            { id: "two", name: "Second", eligible: 20 },
          ],
        },
        data_progress: { stage: "validating", completed: 2, total: 4 },
      }}
      workers={[]}
      telemetry={{
        ...telemetry,
        samples: [
          ...Array.from({ length: 4 }, (_, index) => ({
            sample_id: `one-${index}`,
            collection_id: "one",
            role: "general" as const,
            category: "amount",
            label: String(index),
            image_url: `/crop-${index}`,
          })),
          {
            sample_id: "unattributed",
            role: "names",
            category: "name",
            label: "Unknown source",
            image_url: "/unknown",
          },
        ],
      }}
    />,
  );
  expect(
    within(screen.getByRole("region", { name: "First preparation samples" })).getAllByRole("img"),
  ).toHaveLength(4);
  expect(
    within(screen.getByRole("region", { name: "Second preparation samples" })).queryByRole("img"),
  ).toBeNull();
  expect(screen.getByText("Collection previews unavailable for this version.")).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Dataset example: Unknown source" })).toBeNull();
  expect(screen.getByText("✓ Read captures")).toHaveAttribute("data-state", "complete");
  expect(screen.getByText("Validate crops")).toHaveAttribute("data-state", "active");
});
it("bounds and deduplicates SVG observations without interpolating missing samples", () => {
  const { container } = render(
    <LossHistory
      history={{
        role: "names",
        stage_id: "names",
        points: Array.from({ length: 200 }, (_, step) => ({
          step: Math.floor(step / 2),
          loss: step / 100,
        })),
      }}
    />,
  );
  expect(container.querySelector("polyline")?.getAttribute("points")?.split(" ")).toHaveLength(100);
  expect(screen.getByRole("img")).toHaveAccessibleName(/100 observations/);
});

it("keeps completed Results to scorecards, comparison bars and action rows until inspection opens", () => {
  const scored = {
    ...run,
    status: "completed" as const,
    benchmark: {
      exact_match: 0.95,
      cer: 0.01,
      p95_ms: 8,
      results: [
        {
          role: "general" as const,
          category: "all",
          condition: "identity",
          samples: 100,
          exact_match: 0.99,
          baseline_exact_match: 0.98,
          cer: 0.01,
          p95_ms: 8,
          regressions: 0,
          improved: 1,
        },
        {
          role: "names" as const,
          category: "all",
          condition: "identity",
          samples: 50,
          exact_match: 0.96,
          baseline_exact_match: 0.9,
          cer: 0.02,
          p95_ms: 7,
          regressions: 2,
          improved: 5,
        },
      ],
    },
  };
  const evidence = {
    ...telemetry,
    benchmark: {
      ...telemetry.benchmark!,
      cases: Array.from({ length: 16 }, (_, index) => ({
        ...telemetry.benchmark!.cases[index % 2]!,
        sample_id: `case-${index}`,
      })),
    },
  };
  const { container } = render(<TrainingActivity run={scored} workers={[]} telemetry={evidence} />);
  expect(
    within(screen.getByRole("region", { name: "General results" })).getByText("99.00%"),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "General results" })).getByText(
      "0 regressions · 1 improvement",
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Names results" })).getByText("96.00%"),
  ).toBeTruthy();
  expect(container.querySelectorAll(".training-result-card")).toHaveLength(2);
  expect(container.querySelectorAll(".training-case")).toHaveLength(0);
  expect(screen.queryByRole("group", { name: "Benchmark case outcome" })).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.getByRole("region", { name: "Baseline versus Names exact match" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Review regressions/ }));
  fireEvent.click(screen.getByRole("button", { name: "Next General example" }));
  expect(
    within(screen.getByRole("region", { name: "General benchmark evidence" })).getByText(
      "Retained example 2 / 8",
    ),
  ).toBeTruthy();
});
it("retains an honest combined score for legacy summaries without per-model results", () => {
  render(
    <TrainingActivity
      run={{
        ...run,
        status: "completed",
        benchmark: {
          exact_match: 0.93,
          baseline_exact_match: 0.91,
          cer: 0.01,
          p95_ms: 8,
          regressions: 1,
          improved: 4,
        },
      }}
      workers={[]}
      telemetry={undefined}
    />,
  );
  expect(
    within(screen.getByLabelText("Combined benchmark result")).getByText("93.00%"),
  ).toBeTruthy();
  expect(screen.getAllByText("Per-model score unavailable")).toHaveLength(2);
});

it("labels retained prior-phase history while the next phase waits for measurements", () => {
  render(
    <TrainingActivity
      run={run}
      workers={[
        { role: "names", host: "remote", state: "initializing", stage_id: "names", epochs: 6 },
      ]}
      telemetry={{
        histories: [{ role: "names", stage_id: "names-base", points: [{ step: 1, loss: 0.2 }] }],
        samples: [],
      }}
    />,
  );
  const lane = screen.getByRole("article", { name: "Names worker" });
  expect(within(lane).getByText("Previous phase loss · Names specialization")).toBeTruthy();
  expect(lane.querySelector("figure")).toHaveAttribute("data-stage", "names-base");
  expect(within(lane).getByText("6 epochs planned")).toBeTruthy();
  expect(within(lane).getByText("Initializing model and data loader")).toBeTruthy();
});

it("shows known epoch targets and the shared-base dependency before any measurement", () => {
  render(
    <TrainingActivity
      run={run}
      workers={[
        { role: "general", host: "local", state: "initializing", stage_id: "base", epochs: 8 },
        { role: "names", host: "remote", state: "waiting", stage_id: "names-base", epochs: 4 },
      ]}
      telemetry={undefined}
    />,
  );
  const names = screen.getByRole("article", { name: "Names worker" });
  expect(within(names).getByText("Next phase 2 of 3")).toBeTruthy();
  const path = within(names).getByRole("list", { name: "Names training phases" });
  expect(within(path).getByText("Shared base")).toHaveAttribute("data-state", "active");
  expect(within(path).getByText("Specialization")).toHaveAttribute("data-state", "pending");
  expect(path.querySelectorAll('[data-state="complete"]')).toHaveLength(0);
  expect(within(names).getByText("4 epochs planned")).toBeTruthy();
  const progress = within(names).getByRole("progressbar", { name: "Names epoch progress" });
  expect(progress).toHaveAttribute("aria-valuemax", "4");
  expect(progress).not.toHaveAttribute("aria-valuenow");
  expect(progress.querySelectorAll('[data-state="pending"]')).toHaveLength(4);
  expect(within(names).getByText("Waiting for shared base model")).toBeTruthy();
});

it("does not report the phase completed merely because its final epoch started", () => {
  render(
    <TrainingActivity
      run={run}
      workers={[
        {
          role: "general",
          host: "local",
          state: "training",
          stage_id: "base",
          epoch: 8,
          epochs: 8,
        },
      ]}
      telemetry={telemetry}
    />,
  );
  const lane = screen.getByRole("article", { name: "General worker" });
  const path = within(lane).getByRole("list", { name: "General training phases" });
  expect(within(path).getByText("Shared base")).toHaveAttribute("data-state", "active");
  const progress = within(lane).getByRole("progressbar");
  expect(progress).toHaveAttribute("aria-valuenow", "8");
  expect(progress).toHaveAttribute("aria-valuetext", "Epoch 8 of 8; Training");
  expect(progress.lastElementChild).toHaveAttribute("data-state", "active");
});

it("clears stale measurements while showing the actual transfer operation", () => {
  render(
    <TrainingActivity
      run={run}
      workers={[
        {
          role: "general",
          host: "local",
          state: "waiting",
          stage_id: "general",
          epochs: 4,
          epoch: 8,
          loss: 0.00507,
          global_step: 15000,
          waiting_reason: "Waiting for checkpoint transfer to unimatrix-01",
        },
      ]}
      telemetry={telemetry}
    />,
  );
  const lane = screen.getByRole("article", { name: "General worker" });
  expect(within(lane).getByText("Phase 2 of 2")).toBeTruthy();
  expect(within(lane).getByText("Waiting for checkpoint transfer to unimatrix-01")).toBeTruthy();
  expect(within(lane).queryByText("0.00507")).toBeNull();
  expect(within(lane).queryByText("15,000")).toBeNull();
  expect(within(lane).getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  expect(within(lane).getByText("✓ Shared base")).toHaveAttribute("data-state", "complete");
});

it("keeps completion, failure and post-training export operations explicit", () => {
  const view = render(
    <TrainingActivity
      run={{ ...run, stage: "Exporting and checking model parity" }}
      workers={[
        {
          role: "general",
          host: "local",
          state: "completed",
          stage_id: "general",
          epoch: 4,
          epochs: 4,
        },
      ]}
      telemetry={undefined}
    />,
  );
  expect(screen.getByText("Exporting and checking model parity")).toBeTruthy();
  const lane = screen.getByRole("article", { name: "General worker" });
  expect(within(lane).getByText("General refinement complete")).toBeTruthy();
  expect(lane.querySelectorAll('.training-stage-path [data-state="complete"]')).toHaveLength(2);
  view.rerender(
    <TrainingActivity
      run={{ ...run, status: "failed" }}
      workers={[
        {
          role: "general",
          host: "local",
          state: "failed",
          stage_id: "general",
          epochs: 4,
          error: "CUDA process failed",
        },
      ]}
      telemetry={undefined}
    />,
  );
  expect(within(lane).getByText("CUDA process failed")).toBeTruthy();
  expect(within(lane).getByText("No loss measurements retained for this phase.")).toBeTruthy();
  expect(within(lane).getByText("Training failed")).toBeTruthy();
});

it("bounds epoch segments while keeping a large reported target truthful", () => {
  render(
    <TrainingActivity
      run={run}
      workers={[
        {
          role: "general",
          host: "local",
          state: "training",
          stage_id: "base",
          epoch: 2,
          epochs: 1000000,
        },
      ]}
      telemetry={undefined}
    />,
  );
  const progress = screen.getByRole("progressbar", { name: "General epoch progress" });
  expect(progress).toHaveAttribute("aria-valuemax", "1000000");
  expect(progress.children).toHaveLength(100);
});

it.each(["failed", "interrupted"])(
  "keeps the Names dependency unresolved after shared base is %s",
  (state) => {
    render(
      <TrainingActivity
        run={{ ...run, status: state === "failed" ? "failed" : "interrupted" }}
        workers={[
          { role: "general", host: "local", state, stage_id: "base", epoch: 8, epochs: 8 },
          { role: "names", host: "remote", state: "waiting", stage_id: "names-base", epochs: 4 },
        ]}
        telemetry={undefined}
      />,
    );
    const names = screen.getByRole("article", { name: "Names worker" });
    const path = within(names).getByRole("list", { name: "Names training phases" });
    expect(path.querySelectorAll('[data-state="complete"]')).toHaveLength(0);
    expect(within(path).getByText("Shared base")).toHaveAttribute("data-state", "active");
    expect(within(names).getByText("Waiting for shared base model")).toBeTruthy();
  },
);

it.each([undefined, "Waiting for base checkpoint"])(
  "retains the checkpoint dependency after shared base finishes with reason %s",
  (waitingReason) => {
    render(
      <TrainingActivity
        run={run}
        workers={[
          {
            role: "general",
            host: "local",
            state: "training",
            stage_id: "general",
            epoch: 1,
            epochs: 4,
          },
          {
            role: "names",
            host: "remote",
            state: "waiting",
            stage_id: "names-base",
            epochs: 4,
            ...(waitingReason ? { waiting_reason: waitingReason } : {}),
          },
        ]}
        telemetry={undefined}
      />,
    );
    const names = screen.getByRole("article", { name: "Names worker" });
    expect(within(names).getByText("Waiting for base checkpoint")).toBeTruthy();
    expect(within(names).queryByText("Waiting for worker")).toBeNull();
    const path = within(names).getByRole("list", { name: "Names training phases" });
    expect(within(path).getByText("✓ Shared base")).toHaveAttribute("data-state", "complete");
    expect(within(path).getByText("Specialization")).toHaveAttribute("data-state", "active");
    expect(within(names).getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  },
);

it.each(["failed", "interrupted", "completed", "inherited"])(
  "prioritizes terminal %s state over a stale initialization reason",
  (state) => {
    render(
      <TrainingActivity
        run={run}
        workers={[
          {
            role: "general",
            host: "local",
            state,
            stage_id: "general",
            epochs: 4,
            waiting_reason: "Initializing model and data loader",
            ...(state === "failed" ? { error: "Paddle process could not start" } : {}),
          },
        ]}
        telemetry={undefined}
      />,
    );
    const lane = screen.getByRole("article", { name: "General worker" });
    expect(within(lane).queryByText("Initializing model and data loader")).toBeNull();
    expect(lane.querySelector(".training-job-operation")).toHaveTextContent(
      state === "failed"
        ? "Training failed"
        : state === "interrupted"
          ? "Training stopped"
          : state === "completed"
            ? "General refinement complete"
            : "Using active model",
    );
    if (state === "failed")
      expect(within(lane).getByText("Paddle process could not start")).toBeTruthy();
  },
);
