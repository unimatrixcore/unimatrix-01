import { expect, test, type Page } from "@playwright/test";
import { installLabFixture } from "./fixture.js";

function installTrainingFixture() {
  const prior = window.__POKER_LAB_TEST_INVOKE__!;
  const control = {
    mode: "idle",
    setupError: "",
    startPreparing: false,
    blocked: false,
    checks: [] as unknown[],
    submissions: [] as unknown[],
    holdAnalysis: false,
    releaseAnalysis: false,
    sharedBase: false,
    transition: false,
    initializing: false,
    exporting: false,
    recipePhase: "",
    evidence: false,
    manyVersions: false,
    conditionRequests: [] as string[],
  };
  Object.assign(window, { trainingFixture: control });
  const collections = [
    {
      id: "fixture",
      name: "Evening tables",
      total: 1640,
      reviewed: 1500,
      eligible: 1428,
      names: 310,
      blanks: 82,
      pending: 140,
      blocked: 72,
      archived: false,
    },
    {
      id: "second",
      name: "Weekend session",
      total: 940,
      reviewed: 940,
      eligible: 900,
      names: 176,
      blanks: 34,
      pending: 0,
      blocked: 40,
      archived: false,
    },
  ];
  const analysis = () => ({
    ready: !control.blocked,
    accepted: 1428,
    duplicates: 100,
    rejected: 72,
    names: 310,
    blanks: 82,
    train: 1000,
    validation: 150,
    test: 278,
    blockers: control.blocked ? ["No eligible names remain after verification."] : [],
    exclusions: [
      { reason: "unreviewed_pixels", count: 48 },
      { reason: "label_conflict", count: 24 },
    ],
    collections,
  });
  const workers = () => [
    {
      role: "general",
      stage_id: control.sharedBase || control.recipePhase === "base" ? "base" : "general",
      host: "local",
      gpu: "RTX 4060",
      state:
        control.mode === "failed"
          ? "failed"
          : control.mode === "running"
            ? "training"
            : control.mode === "stopped"
              ? "interrupted"
              : "completed",
      epoch:
        control.sharedBase || control.recipePhase === "base"
          ? 8
          : control.mode === "failed"
            ? 4
            : control.mode === "completed"
              ? 6
              : 3,
      epochs:
        control.sharedBase || control.recipePhase === "base" ? 8 : control.recipePhase ? 4 : 6,
      loss: 0.02418,
      elapsed_seconds: 188,
      global_step: control.mode === "completed" ? 2280 : control.mode === "failed" ? 1268 : 888,
      steps_per_epoch: 380,
      ...(control.transition
        ? {
            state: control.initializing ? "initializing" : "waiting",
            stage_id: "general",
            epochs: 4,
            epoch: undefined,
            loss: undefined,
            global_step: undefined,
            waiting_reason: control.initializing
              ? "Initializing model and data loader"
              : "Waiting for checkpoint transfer to unimatrix-01",
          }
        : {}),
      ...(control.exporting ? { state: "completed" } : {}),
    },
    {
      role: "names",
      stage_id:
        control.sharedBase || ["base", "parallel"].includes(control.recipePhase)
          ? "names-base"
          : "names",
      host: "unimatrix-01",
      gpu: "RTX 3060",
      state:
        control.sharedBase || control.recipePhase === "base"
          ? "waiting"
          : control.mode === "running"
            ? "training"
            : control.mode === "stopped"
              ? "interrupted"
              : "completed",
      epoch:
        control.sharedBase || control.recipePhase === "base"
          ? undefined
          : control.mode === "completed" || control.mode === "failed"
            ? 6
            : 2,
      epochs: control.recipePhase === "parallel" ? 4 : 6,
      loss: control.sharedBase ? undefined : 0.03942,
      elapsed_seconds: control.sharedBase ? undefined : 175,
      global_step: control.sharedBase
        ? undefined
        : control.mode === "completed" || control.mode === "failed"
          ? 1320
          : 314,
      steps_per_epoch: 220,
      ...(control.transition
        ? {
            state: control.initializing ? "initializing" : "waiting",
            stage_id: "names-base",
            epochs: 4,
            epoch: undefined,
            loss: undefined,
            global_step: undefined,
            waiting_reason: control.initializing
              ? "Initializing model and data loader"
              : "Transferring training data and shared checkpoint to unimatrix-01",
          }
        : {}),
      ...(control.exporting ? { state: "completed" } : {}),
    },
  ];
  const results = ["identity", "brightness_minus30", "jpeg80", "scale60"].flatMap(
    (condition, index) =>
      ["all", "name"].flatMap((category) =>
        ["general", "names"].map((role) => ({
          role,
          condition,
          category,
          samples: role === "general" ? 208 : 70,
          exact_match: 0.98 - index * 0.01,
          baseline_exact_match: 0.96 - index * 0.02,
          cer: 0.01 + index * 0.002,
          p95_ms: role === "general" ? 8.5 : 6.2,
          regressions: 1,
          improved: 5,
          processing_errors: condition === "jpeg80" && role === "names" ? 1 : 0,
        })),
      ),
  );
  const version = () => ({
    id: "opaque-uuid-do-not-heading",
    kind: "training",
    version: 1,
    display_name: "Version 1",
    created_at: 1794612000000,
    can_resume: control.mode === "failed",
    status: ["preparing", "benchmarking"].includes(control.mode)
      ? control.mode
      : control.mode === "failed"
        ? "failed"
        : control.mode === "running"
          ? "training"
          : control.mode === "stopped"
            ? "interrupted"
            : "completed",
    stage: control.exporting
      ? "Exporting and checking model parity"
      : control.transition
        ? "Transferring shared checkpoint to unimatrix-01"
        : control.mode === "failed"
          ? "Training failed"
          : control.mode === "running"
            ? "Training general and names models"
            : control.mode === "stopped"
              ? "Stopped"
              : "Benchmark complete",
    error: control.mode === "stopped" ? "Training stopped by user." : null,
    collections: control.mode === "preparing" ? ["fixture", "second"] : ["fixture"],
    ...(control.mode === "preparing"
      ? { data_progress: { stage: "validating", completed: 2, total: 4 } }
      : {}),
    epochs: 6,
    workers: workers(),
    analysis: analysis(),
    summary: {
      accepted: 1428,
      duplicates: 100,
      rejected: 72,
      train: 1000,
      validation: 150,
      test: 278,
      selected_training: 1000,
      inherited_holdouts: 150,
      inherited_blank_controls: 50,
    },
    ...(control.mode === "completed"
      ? {
          benchmark: {
            exact_match: 0.98,
            cer: 0.01,
            p95_ms: 8.5,
            baseline_exact_match: 0.96,
            regressions: 1,
            improved: 5,
            results,
          },
        }
      : {}),
  });
  let analyses: unknown[] = [];
  window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
    const ok = (body: unknown, status = 200) => ({ status, headers: {}, body });
    if (request.path === "/api/datasets")
      return request.query.background_page === "1"
        ? ok({
            items: collections,
            nextCursor: null,
            hasMore: false,
            total: collections.length,
            meta: { default_dataset_id: "fixture" },
          })
        : ok({ datasets: collections, default_dataset_id: "fixture" });
    if (request.path === "/api/training/probe") return ok({ checking: false });
    if (request.path === "/api/training/analyze") {
      control.checks.push(request.body);
      while (control.holdAnalysis && !control.releaseAnalysis)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const body = request.body as { collections: string[]; epochs: number };
      const run = {
        id: `analysis-${control.checks.length}`,
        kind: "analysis",
        created_at: Date.now(),
        status: "completed",
        stage: "Collections checked",
        collections: body.collections,
        epochs: body.epochs,
        analysis: analysis(),
      };
      analyses = [run];
      return ok({ run }, 202);
    }
    if (request.path.endsWith("/resume")) {
      control.mode = "running";
      return ok({ run: version() }, 202);
    }
    if (request.path.endsWith("/cancel")) {
      control.mode = "stopped";
      return ok({ run: version() });
    }
    if (request.path === "/api/training") {
      if (request.method === "POST") {
        control.submissions.push(request.body);
        control.mode = control.startPreparing ? "preparing" : "completed";
        return ok({ run: version() }, 202);
      }
      return ok({
        runs:
          control.mode === "idle"
            ? []
            : control.manyVersions
              ? Array.from({ length: 40 }, (_, index) => ({
                  ...version(),
                  id: index === 0 ? "opaque-uuid-do-not-heading" : `archived-${index}`,
                  version: index + 1,
                  display_name: `Version ${index + 1}`,
                }))
              : [version()],
        analyses,
        collections,
        setup: { ready: !control.setupError, error: control.setupError || null },
        active_release: {
          name: "Current release",
          general_sha256: "a".repeat(64),
          names_sha256: "b".repeat(64),
        },
        gpu_status: {
          checked_at: Date.now(),
          devices: [
            { host: "local", gpu: "RTX 4060", ready: true },
            { host: "unimatrix-01", gpu: "RTX 3060", ready: true },
          ],
        },
      });
    }
    if (request.path.startsWith("/api/training/")) {
      const condition = String(request.query.condition ?? "identity");
      control.conditionRequests.push(condition);
      return ok({
        run: version(),
        telemetry: control.evidence
          ? {
              samples: Array.from({ length: 8 }, (_, index) => ({
                sample_id: `prep-${index}`,
                collection_id: index < 4 ? "fixture" : "second",
                role: "names",
                category: "name",
                label: `Player ${index}`,
                image_url: `/api/training/sample?sample_id=prep-${index}`,
              })),
              histories: [
                ...workers().map((worker) => ({
                  role: worker.role,
                  stage_id: worker.stage_id,
                  points: [
                    { step: 1, loss: 0.8 },
                    { step: 2, loss: 0.3 },
                  ],
                })),
                {
                  role: "general",
                  stage_id: "base",
                  points: [
                    { step: 1, loss: 0.9 },
                    { step: 2, loss: 0.6 },
                  ],
                },
                {
                  role: "names",
                  stage_id: "names-base",
                  points: [
                    { step: 1, loss: 0.8 },
                    { step: 2, loss: 0.5 },
                  ],
                },
              ],
              benchmark: {
                pass: "candidate",
                processed: 16,
                total: 16,
                cases: Array.from({ length: 16 }, (_, index) => ({
                  sample_id: `sample-${index}`,
                  role: index % 2 ? "names" : "general",
                  category: index % 2 ? "name" : "amount",
                  condition,
                  label: `${condition} ${index % 2 ? "Player 5" : "$10"}`,
                  baseline_prediction: index % 2 ? "Player5" : "$10",
                  candidate_prediction: index % 2 ? "Player 5" : "$1",
                  baseline_exact: index % 2 === 0,
                  candidate_exact: index % 2 !== 0,
                  image_url: `/api/training/sample?run=opaque-uuid-do-not-heading&sample_id=sample-${index}`,
                })),
              },
            }
          : undefined,
        workers: workers(),
        analysis: analysis(),
        logs: { general: "epoch: [3/6], loss: 0.02418", names: "epoch: [2/6], loss: 0.03942" },
      });
    }
    return prior(request);
  };
}
async function openCollections(page: Page) {
  const picker = page.getByRole("button", { name: /^Collections ·/ });
  if ((await picker.getAttribute("aria-expanded")) !== "true") await picker.click();
  await expect(page.getByRole("menu")).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${installTrainingFixture.toString()})();`,
  });
});
test("starts selected collections without a preflight audit and compares model versions", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/training");
  await openCollections(page);
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  expect(await page.evaluate(() => !!window.pokerOcrReady)).toBe(false);
  const start = page.getByRole("button", { name: "Start training" });
  await expect(start).toBeDisabled();
  const training = page.getByRole("region", { name: "OCR Training", exact: true });
  await expect(training.getByRole("region", { name: "Model versions" })).toBeVisible();
  await expect(training.getByRole("link", { name: "Gameplay", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Gameplay", exact: true })).toHaveCount(1);
  await page.getByRole("menuitemcheckbox", { name: "Evening tables" }).click();
  await expect(start).toBeEnabled();
  await expect(page.getByLabel("Selected data counts")).toContainText("1,428 eligible");
  await page.screenshot({ path: "/tmp/poker-training-readiness.png", fullPage: true });
  await start.click();
  await expect(page.getByRole("heading", { name: "Version 1", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "opaque-uuid-do-not-heading" })).toHaveCount(0);
  await page.getByRole("button", { name: /^Compare stress conditions/ }).click();
  const benchmark = page.getByRole("region", { name: "Benchmark comparison" });
  await expect(benchmark.getByRole("row")).toHaveCount(3);
  await expect(benchmark.getByText("+2.00 pp")).toHaveCount(2);
  await benchmark.getByRole("button", { name: "Darker", exact: true }).click();
  await expect(benchmark.getByText("+3.00 pp")).toHaveCount(2);
  await benchmark.getByRole("button", { name: "JPEG", exact: true }).click();
  await expect(benchmark.getByText("1 error")).toBeVisible();
  await benchmark.getByRole("button", { name: "Darker", exact: true }).click();
  await benchmark.getByRole("combobox", { name: "Benchmark category" }).selectOption("name");
  await expect(benchmark.getByRole("combobox", { name: "Benchmark category" })).toHaveValue("name");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Logs", exact: true }).click();
  await expect(page.getByRole("rowheader", { name: "unreviewed pixels" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => {
    document.getElementById("main-content")!.scrollTop = 0;
  });
  await page.screenshot({ path: "/tmp/poker-training-completed.png", fullPage: true });
  await page.getByRole("link", { name: "OCR Data", exact: true }).click();
  await expect(page.locator("#section-ocr-data")).toBeVisible();
  await page.getByRole("link", { name: "Gameplay", exact: true }).click();
  await expect(page.locator(".gameplay-workspace")).toBeVisible();
  await page.getByRole("link", { name: "OCR Training", exact: true }).click();
  await openCollections(page);
  await expect(page.getByRole("menuitemcheckbox", { name: "Evening tables" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.goBack();
  await expect(page.locator(".gameplay-workspace")).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("region", { name: "OCR Training", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 800, height: 700 });
  await page.evaluate(() => {
    document.getElementById("main-content")!.scrollTop = 0;
  });
  await page.screenshot({ path: "/tmp/poker-training-narrow.png", fullPage: true });
  expect(errors).toEqual([]);
});
test("shows actual paired GPU progress and a neutral user stop", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { trainingFixture: { mode: string } }).trainingFixture.mode = "running";
  });
  await page.goto("/training");
  await openCollections(page);
  await expect(page.getByText("Loss appears after the first training measurement.")).toHaveCount(2);
  await expect(page.getByRole("menuitemcheckbox", { name: "Evening tables" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("article", { name: "General worker" })).toContainText("3 / 6");
  await expect(page.getByRole("article", { name: "Names worker" })).toContainText(
    "unimatrix-01 · RTX 3060",
  );
  await page.screenshot({ path: "/tmp/poker-training-running.png", fullPage: true });
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveAttribute(
    "data-variant",
    "destructive",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Model versions" }).getByRole("button", { pressed: true }),
  ).toContainText("Stopped");
  await openCollections(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("menuitemcheckbox", { name: "Evening tables" })).toBeEnabled();
  await page.screenshot({ path: "/tmp/poker-training-stopped.png", fullPage: true });
});
test("does not run preparation or gate Start on a pre-training data audit", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign((window as unknown as { trainingFixture: object }).trainingFixture, {
      blocked: true,
      startPreparing: true,
    });
  });
  await page.goto("/training");
  await openCollections(page);
  await page.getByRole("menuitemcheckbox", { name: "Evening tables" }).click();
  await expect(page.getByRole("button", { name: "Start training" })).toBeEnabled();
  await expect(page.getByText("No eligible names remain after verification.")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { trainingFixture: { checks: unknown[] } }).trainingFixture.checks,
    ),
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Start training", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Preparing collections" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => {
      const fixture = (
        window as unknown as { trainingFixture: { checks: unknown[]; submissions: unknown[] } }
      ).trainingFixture;
      return { checks: fixture.checks.length, submissions: fixture.submissions.length };
    }),
  ).toEqual({ checks: 0, submissions: 1 });
});
test("training capture shortcuts remain inactive and setup errors stay actionable", async ({
  page,
}) => {
  await page.goto("/collection");
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  await page.getByRole("link", { name: "OCR Training", exact: true }).click();
  await page.keyboard.press("c");
  await expect(page.getByText("Fixture capture has no live table.")).toHaveCount(0);
  await expect(page.getByRole("spinbutton", { name: "Epochs" })).toHaveCount(0);
  if (!(await page.getByRole("menuitemcheckbox", { name: "Evening tables" }).isVisible()))
    await openCollections(page);
  await page.getByRole("menuitemcheckbox", { name: "Evening tables" }).click();
  await expect(page.getByRole("button", { name: "Start training" })).toBeEnabled();
});
test("resumes a failed model version without creating another training run", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { trainingFixture: { mode: string } }).trainingFixture.mode = "failed";
  });
  await page.goto("/training");
  await openCollections(page);
  const resume = page.getByRole("button", { name: "Resume training", exact: true });
  await expect(resume).toBeEnabled();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("menuitemcheckbox", { name: "Evening tables" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByRole("button", { name: "Start training", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Version 1", exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/poker-training-resume.png", fullPage: true });
  await resume.click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Version 1", exact: true })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Model versions" }).getByRole("button"),
  ).toHaveCount(1);
});

test("Names explains that it is waiting for the shared base model", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(
      (window as unknown as { trainingFixture: { mode: string; sharedBase: boolean } })
        .trainingFixture,
      { mode: "running", sharedBase: true },
    );
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/training");
  await openCollections(page);
  await expect(page.getByText("Waiting for shared base model", { exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: "General worker" })).toContainText("8 / 8");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("names-shared-base-waiting.png") });
  expect(errors).toEqual([]);
});

test("keeps stable worker columns across actual phase counter resets", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(
      (window as unknown as { trainingFixture: { mode: string; recipePhase: string } })
        .trainingFixture,
      { mode: "running", recipePhase: "base" },
    );
  });
  await page.goto("/training");
  const general = page.getByRole("article", { name: "General worker", exact: true });
  const names = page.getByRole("article", { name: "Names worker", exact: true });
  await expect(general).toContainText("8 / 8");
  await expect(general).toHaveAttribute("data-stage", "base");
  await page.evaluate(() => {
    (
      window as unknown as { trainingFixture: { recipePhase: string } }
    ).trainingFixture.recipePhase = "parallel";
  });
  await expect(general).toHaveAttribute("data-stage", "general");
  await expect(general).toContainText("3 / 4");
  await expect(names).toContainText("2 / 4");
  await page.evaluate(() => {
    (
      window as unknown as { trainingFixture: { recipePhase: string } }
    ).trainingFixture.recipePhase = "names";
  });
  await expect(names).toHaveAttribute("data-stage", "names");
  await expect(names).toContainText("2 / 6");
  await expect(page.getByRole("tab")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("training-stable-lanes.png") });
});

test("fits both completed model results without overflow and restores the long version rail", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.route("**/api/training/sample?**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="36"><rect width="160" height="36" fill="#202020"/><text x="8" y="25" fill="white">Fixture crop</text></svg>',
    }),
  );
  await page.addInitScript(() => {
    Object.assign(
      (
        window as unknown as {
          trainingFixture: { mode: string; evidence: boolean; manyVersions: boolean };
        }
      ).trainingFixture,
      { mode: "completed", evidence: true, manyVersions: true },
    );
  });
  await page.goto("/training");
  const training = page.getByRole("region", { name: "OCR Training", exact: true });
  await expect(
    page.getByRole("heading", { name: "Benchmark complete", exact: true }),
  ).toBeVisible();
  await expect.poll(async () => Math.round((await training.boundingBox())!.width)).toBe(1216);
  const setup = page.locator(".training-setup-panel"),
    panes = page.locator(".training-master-detail");
  const setupBox = (await setup.boundingBox())!,
    panesBox = (await panes.boundingBox())!;
  expect(setupBox.width).toBeCloseTo(panesBox.width, 0);
  expect(setupBox.y + setupBox.height).toBeLessThan(panesBox.y);
  expect(panesBox.y + panesBox.height).toBeGreaterThan(1040);
  expect(panesBox.y + panesBox.height).toBeLessThanOrEqual(1057);
  await expect(training.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Gameplay", exact: true })).toHaveCount(1);
  const detail = page.locator('[data-training-scroll="opaque-uuid-do-not-heading"]');
  await expect(page.getByRole("region", { name: "General results", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Names results", exact: true })).toBeVisible();
  await expect(page.locator(".training-case")).toHaveCount(0);
  const viewBox = (await detail.boundingBox())!;
  for (const role of ["General", "Names"]) {
    const scoreBox = (await page
      .getByRole("region", { name: `${role} results`, exact: true })
      .boundingBox())!;
    expect(scoreBox.y).toBeGreaterThanOrEqual(viewBox.y);
    expect(scoreBox.y + scoreBox.height).toBeLessThanOrEqual(viewBox.y + viewBox.height);
  }
  expect(await detail.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  await page.getByRole("button", { name: /^Review regressions/ }).click();
  await page.getByRole("combobox", { name: "Result condition" }).selectOption("jpeg80");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { trainingFixture: { conditionRequests: string[] } }
        ).trainingFixture.conditionRequests.includes("jpeg80"),
      ),
    )
    .toBe(true);
  await expect(page.locator(".training-case-target").first()).toContainText("jpeg80");
  await expect(page.getByRole("region", { name: "General results", exact: true })).toContainText(
    "96.00%",
  );
  await page.getByRole("combobox", { name: "Result condition" }).selectOption("identity");
  await expect(page.locator(".training-case-target").first()).toContainText("identity");
  await page.keyboard.press("Escape");
  const versions = page.locator('[data-training-scroll="versions"]');
  await versions.evaluate((node) => {
    node.scrollTop = 420;
  });
  await expect.poll(() => versions.evaluate((node) => node.scrollTop)).toBe(420);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            JSON.parse(localStorage.getItem("poker-lab:workspace:v1") || "{}") as {
              trainingPanes?: Record<string, { top: number }>;
            }
          ).trainingPanes?.versions?.top,
      ),
    )
    .toBe(420);
  await page.reload();
  await expect.poll(() => versions.evaluate((node) => node.scrollTop)).toBe(420);
  await page.screenshot({
    path: test.info().outputPath("training-compact-results-and-restored-rail.png"),
  });
});

test("shows stage-first columns with epoch bars and loss graphs below", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.addInitScript(() => {
    Object.assign(
      (
        window as unknown as {
          trainingFixture: { mode: string; evidence: boolean; recipePhase: string };
        }
      ).trainingFixture,
      { mode: "running", evidence: true, recipePhase: "names" },
    );
  });
  await page.goto("/training");
  const general = page.getByRole("article", { name: "General worker", exact: true });
  const names = page.getByRole("article", { name: "Names worker", exact: true });
  await expect(general.locator("figure").getByRole("img")).toHaveCount(1);
  await expect(names.locator("figure").getByRole("img")).toHaveCount(1);
  await expect(general.locator("figure")).toHaveAttribute("data-stage", "general");
  await expect(names.locator("figure")).toHaveAttribute("data-stage", "names");
  const detail = page.locator('[data-training-scroll="opaque-uuid-do-not-heading"]');
  expect(await detail.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  const viewport = (await detail.boundingBox())!,
    generalBox = (await general.boundingBox())!,
    namesBox = (await names.boundingBox())!;
  expect(namesBox.x).toBeGreaterThan(generalBox.x + generalBox.width);
  expect(namesBox.y).toBeCloseTo(generalBox.y, 0);
  expect(namesBox.height).toBeCloseTo(generalBox.height, 0);
  expect(namesBox.y + namesBox.height).toBeLessThanOrEqual(viewport.y + viewport.height);
  await expect(
    general.getByRole("progressbar", { name: "General epoch progress" }),
  ).toHaveAttribute("aria-valuenow", "3");
  await expect(names.getByRole("progressbar", { name: "Names epoch progress" })).toHaveAttribute(
    "aria-valuemax",
    "6",
  );
  await page.screenshot({ path: test.info().outputPath("training-current-stage-lanes-fit.png") });
});

for (const state of ["preparing", "running", "benchmarking", "completed"]) {
  test(`original B composition fits the desktop in ${state}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route("**/api/training/sample?**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="36"><rect width="160" height="36" fill="#1c303b"/><text x="8" y="25" fill="white">Player 5</text></svg>',
      }),
    );
    await page.addInitScript(
      (mode) =>
        Object.assign((window as unknown as { trainingFixture: object }).trainingFixture, {
          mode,
          evidence: true,
          recipePhase: "names",
        }),
      state,
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/training");
    const detail = page.locator('[data-training-scroll="opaque-uuid-do-not-heading"]');
    await expect(page.locator(".training-inspector-heading h2")).toHaveText("Version 1");
    if (state === "preparing") {
      await expect(page.locator(".training-collection-row")).toHaveCount(2);
      for (const row of await page.locator(".training-collection-row").all())
        await expect(row.getByRole("img")).toHaveCount(4);
      await expect(page.locator(".training-preparation-split")).toHaveCount(0);
    } else if (state === "running") {
      await expect(page.locator(".training-job-lane")).toHaveCount(2);
      for (const lane of await page.locator(".training-job-lane").all()) {
        await expect(lane.locator("figure")).toHaveCount(1);
        const top = (await lane.locator(".training-job-latest").boundingBox())!,
          graph = (await lane.locator("figure").boundingBox())!;
        expect(graph.y).toBeGreaterThan(top.y + top.height);
        await expect(lane.getByRole("progressbar")).toBeVisible();
        expect(await lane.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("2px");
      }
      const cards = await page.locator(".training-job-lane").all();
      const first = (await cards[0]!.boundingBox())!,
        second = (await cards[1]!.boundingBox())!;
      expect(second.x).toBeGreaterThan(first.x + first.width);
      expect(second.y).toBeCloseTo(first.y, 0);
    } else if (state === "benchmarking") {
      await expect(page.locator(".training-case")).toHaveCount(2);
      for (const lane of await page.locator(".training-pair-lane").all()) {
        await expect(lane.getByRole("img")).toHaveCount(1);
        const crop = (await lane.locator(".training-case-image").boundingBox())!,
          predictions = (await lane.locator(".training-predictions").boundingBox())!;
        expect(predictions.y).toBeGreaterThan(crop.y + crop.height);
        expect(
          await lane
            .locator(".training-predictions")
            .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length),
        ).toBe(1);
      }
    } else {
      await expect(page.locator(".training-result-card")).toHaveCount(2);
      await expect(page.locator(".training-result-actions>button")).toHaveCount(3);
      await expect(page.locator(".training-case")).toHaveCount(0);
      await expect(page.getByRole("combobox", { name: "Result condition" })).toHaveCount(0);
    }
    const counts = (await page.getByLabel("Selected data counts").boundingBox())!;
    const selector = (await page.getByRole("button", { name: /^Collections ·/ }).boundingBox())!;
    const compute = (await page
      .getByRole("group", { name: "Compute availability" })
      .boundingBox())!;
    const action = (await page
      .getByRole("button", { name: state === "completed" ? "Start training" : "Stop", exact: true })
      .boundingBox())!;
    expect(counts.x + counts.width).toBeLessThan(selector.x);
    expect(compute.x + compute.width).toBeLessThan(action.x);
    expect(Math.abs(counts.y + counts.height / 2 - selector.y - selector.height / 2)).toBeLessThan(
      2,
    );
    expect(Math.abs(compute.y + compute.height / 2 - action.y - action.height / 2)).toBeLessThan(2);
    await expect(page.locator(".training-readiness")).toHaveCount(0);
    expect(await detail.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
    expect(
      await page
        .locator("#main-content")
        .evaluate((node) => node.scrollHeight <= node.clientHeight + 1),
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`original-b-${state}.png`) });
    console.log(
      JSON.stringify({
        state,
        setup: await page.locator(".training-setup-panel").boundingBox(),
        panes: await page.locator(".training-master-detail").boundingBox(),
        detail: await detail.boundingBox(),
      }),
    );
    expect(errors).toEqual([]);
  });
}

test("Collections keeps a keyboard multiselection open and updates the trigger count", async ({
  page,
}) => {
  await page.goto("/training");
  const picker = page.getByRole("button", { name: /^Collections ·/ });
  await picker.focus();
  await page.keyboard.press("ArrowDown");
  const first = page.getByRole("menuitemcheckbox", { name: "Evening tables" });
  await expect(first).toBeFocused();
  await page.keyboard.press("Space");
  await expect(first).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(picker).toContainText("Collections · 1");
  await page.keyboard.press("ArrowDown");
  const second = page.getByRole("menuitemcheckbox", { name: "Weekend session" });
  await expect(second).toBeFocused();
  await page.keyboard.press("Space");
  await expect(second).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(picker).toContainText("Collections · 2");
  await page.keyboard.press("Escape");
  await expect(picker).toBeFocused();
});

test("keeps transfer, initialization, epochs and post-training export visible between measurements", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    Object.assign((window as unknown as { trainingFixture: object }).trainingFixture, {
      mode: "running",
      recipePhase: "parallel",
      transition: true,
    });
  });
  await page.goto("/training");
  const general = page.getByRole("article", { name: "General worker", exact: true });
  const names = page.getByRole("article", { name: "Names worker", exact: true });
  await expect(general.locator(".training-job-operation")).toHaveText(
    "Waiting for checkpoint transfer to unimatrix-01",
  );
  await expect(names.locator(".training-job-operation")).toHaveText(
    "Transferring training data and shared checkpoint to unimatrix-01",
  );
  for (const card of [general, names]) {
    await expect(card.getByText("4 epochs planned")).toBeVisible();
    await expect(card.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    await expect(card.locator(".training-chart-pending")).toBeVisible();
    await expect(card.getByText("Epoch not reported")).toHaveCount(0);
  }
  const detail = page.locator('[data-training-scroll="opaque-uuid-do-not-heading"]');
  expect(await detail.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("training-stage-columns-transfer.png") });
  await page.evaluate(() => {
    (
      window as unknown as { trainingFixture: { initializing: boolean } }
    ).trainingFixture.initializing = true;
  });
  await expect(names.locator(".training-job-operation")).toHaveText(
    "Initializing model and data loader",
  );
  await expect(general.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  await page.evaluate(() => {
    Object.assign((window as unknown as { trainingFixture: object }).trainingFixture, {
      transition: false,
      initializing: false,
    });
  });
  await expect(general.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "3");
  await expect(names.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
  await page.evaluate(() => {
    (window as unknown as { trainingFixture: { exporting: boolean } }).trainingFixture.exporting =
      true;
  });
  await expect(page.getByText("Exporting and checking model parity")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("training-stage-columns-export.png") });
});
