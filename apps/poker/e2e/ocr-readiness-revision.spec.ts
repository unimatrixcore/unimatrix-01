import { expect, test } from "@playwright/test";
import { installLabFixture } from "./fixture.js";

type RevisionFixture = {
  revision: string;
  oldComplete: boolean;
  freshComplete: boolean;
  checks: { revision: string; collections: string[]; epochs: number }[];
  starts: number;
  canceled: string[];
  progress: {
    stage: "reading" | "validating" | "deduplicating" | "reserving" | "ready";
    completed?: number;
    total?: number;
    collection_name?: string;
  };
  transitions: {
    revision: string;
    oldComplete: boolean;
    freshComplete: boolean;
    text: string;
    ready: boolean;
    startEnabled: boolean;
  }[];
};

function installRevisionFixture() {
  const previous = window.__POKER_LAB_TEST_INVOKE__!;
  const control: RevisionFixture = {
    revision: "source-1",
    oldComplete: false,
    freshComplete: false,
    checks: [],
    starts: 0,
    canceled: [],
    progress: { stage: "validating", completed: 12, total: 25 },
    transitions: [],
  };
  Object.assign(window, { readinessRevisionFixture: control });
  const collection = () => ({
    id: "fixture",
    name: "Revision collection",
    archived: false,
    revision: control.revision,
    total: control.revision === "source-1" ? 20 : 35,
    reviewed: 18,
    eligible: 16,
    names: 0,
    blanks: 2,
    pending: control.revision === "source-1" ? 2 : 17,
    blocked: 0,
  });
  const collections = () => [
    collection(),
    { ...collection(), id: "second", name: "Second collection" },
  ];
  const ready = () => ({
    ready: true,
    accepted: 16,
    duplicates: 2,
    rejected: 0,
    names: 0,
    blanks: 2,
    train: 12,
    validation: 2,
    test: 2,
    blockers: [],
    collections: [collection()],
  });
  const analysis = (index: number) => ({
    id: `check-${index + 1}`,
    kind: "analysis",
    created_at: 1700000000000 + index,
    status: control.canceled.includes(`check-${index + 1}`)
      ? "interrupted"
      : (index === 0 ? control.oldComplete : control.freshComplete)
        ? "completed"
        : "preparing",
    stage: "Verify collections",
    data_progress: control.progress,
    collections: control.checks[index]?.collections || ["fixture"],
    epochs: control.checks[index]?.epochs || 6,
    analysis: ready(),
  });
  const ok = (body: unknown, status = 200) => ({ status, headers: {}, body });
  window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
    if (request.path === "/api/datasets")
      return request.query.background_page === "1"
        ? ok({
            items: collections(),
            nextCursor: null,
            hasMore: false,
            total: 2,
            meta: { default_dataset_id: "fixture" },
          })
        : ok({ datasets: collections(), default_dataset_id: "fixture" });
    if (request.path === "/api/training/probe") return ok({ checking: false });
    if (request.path === "/api/training/analyze") {
      const body = request.body as { collections: string[]; epochs: number };
      control.checks.push({ ...body, revision: control.revision });
      return ok({ run: analysis(control.checks.length - 1) }, 202);
    }
    if (request.path.endsWith("/cancel")) {
      const id = request.path.split("/").at(-2)!;
      control.canceled.push(id);
      return ok({ run: analysis(Number(id.split("-")[1]) - 1) });
    }
    if (request.path === "/api/training") {
      if (request.method === "POST") control.starts++;
      return ok({
        analysis_protocol: "protocol-1",
        runs: [],
        analyses: control.checks.map((_, index) => analysis(index)).reverse(),
        collections: collections(),
        setup: { ready: true },
        gpu_status: {
          checked_at: Date.now(),
          devices: [
            { host: "local", gpu: "Fixture GPU", ready: true },
            { host: "unimatrix-01", gpu: "Fixture GPU", ready: true },
          ],
        },
      });
    }
    return previous(request);
  };
}

test("a collection revision refreshes metadata without preparing data or blocking Start", async ({
  page,
}) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})();(${installRevisionFixture.toString()})();`,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.goto("/training");
  await page.getByRole("button", { name: /^Collections ·/ }).click();
  const collection = page.getByRole("menuitemcheckbox", {
    name: "Revision collection",
    exact: true,
  });
  await collection.click();
  const start = page.getByRole("button", { name: "Start training", exact: true });
  await expect(start).toBeEnabled();
  await expect(collection).toContainText("2 pending");
  await expect(page.locator(".training-readiness")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Preparing collections" })).toHaveCount(0);
  await page.evaluate(() => {
    (
      window as unknown as { readinessRevisionFixture: RevisionFixture }
    ).readinessRevisionFixture.revision = "source-2";
  });
  await page.clock.runFor(30000);
  await expect(collection).toContainText("17 pending");
  await expect(collection).toHaveAttribute("aria-checked", "true");
  await expect(start).toBeEnabled();
  expect(
    await page.evaluate(() => {
      const control = (window as unknown as { readinessRevisionFixture: RevisionFixture })
        .readinessRevisionFixture;
      return { checks: control.checks, starts: control.starts, canceled: control.canceled };
    }),
  ).toEqual({ checks: [], starts: 0, canceled: [] });
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("revision-ready-without-preparation.png") });
});

test("changing selected collections does not start or cancel preparation, even with a legacy audit", async ({
  page,
}) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})();(${installRevisionFixture.toString()})();`,
  });
  await page.addInitScript(() => {
    (
      window as unknown as { readinessRevisionFixture: RevisionFixture }
    ).readinessRevisionFixture.checks.push({
      revision: "source-1",
      collections: ["fixture"],
      epochs: 6,
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.goto("/training");
  await page.getByRole("button", { name: /^Collections ·/ }).click();
  await page.getByRole("menuitemcheckbox", { name: "Revision collection", exact: true }).click();
  const start = page.getByRole("button", { name: "Start training", exact: true });
  await expect(start).toBeEnabled();
  await page.getByRole("menuitemcheckbox", { name: "Second collection", exact: true }).click();
  await expect(page.getByRole("button", { name: "Collections · 2", exact: true })).toBeVisible();
  await expect(start).toBeEnabled();
  await page.evaluate(() => {
    const control = (window as unknown as { readinessRevisionFixture: RevisionFixture })
      .readinessRevisionFixture;
    control.progress = { stage: "reserving" };
    control.oldComplete = true;
  });
  await page.clock.runFor(32000);
  await expect(page.locator(".training-readiness")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Preparing collections" })).toHaveCount(0);
  await expect(start).toBeEnabled();
  expect(
    await page.evaluate(() => {
      const control = (window as unknown as { readinessRevisionFixture: RevisionFixture })
        .readinessRevisionFixture;
      return { checks: control.checks, starts: control.starts, canceled: control.canceled };
    }),
  ).toEqual({
    checks: [{ revision: "source-1", collections: ["fixture"], epochs: 6 }],
    starts: 0,
    canceled: [],
  });
  expect(errors).toEqual([]);
});

test("a fresh window restores selected collections and default recipe without starting training", async ({
  context,
  page,
}) => {
  await context.addInitScript({
    content: `(${installLabFixture.toString()})();(${installRevisionFixture.toString()})();`,
  });
  await page.goto("/training");
  await page.getByRole("button", { name: /^Collections ·/ }).click();
  await page.getByRole("menuitemcheckbox", { name: "Revision collection", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Second collection", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "Epochs", exact: true })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            JSON.parse(localStorage.getItem("poker-lab:workspace:v1") || "{}") as {
              trainingSelection?: unknown;
            }
          ).trainingSelection,
      ),
    )
    .toEqual({ collections: ["fixture", "second"], epochs: 6 });
  await page.close();
  const next = await context.newPage();
  const errors: string[] = [];
  next.on("pageerror", (error) => errors.push(error.message));
  await next.goto("/");
  await expect(next).toHaveURL(/\/training$/);
  await next.getByRole("button", { name: /^Collections ·/ }).click();
  await expect(
    next.getByRole("menuitemcheckbox", { name: "Revision collection", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    next.getByRole("menuitemcheckbox", { name: "Second collection", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(next.getByRole("spinbutton", { name: "Epochs", exact: true })).toHaveCount(0);
  await expect(next.locator(".training-readiness")).toHaveCount(0);
  await expect(next.getByRole("button", { name: "Start training", exact: true })).toBeEnabled();
  expect(
    await next.evaluate(() => {
      const control = (window as unknown as { readinessRevisionFixture: RevisionFixture })
        .readinessRevisionFixture;
      return { checks: control.checks, canceled: control.canceled };
    }),
  ).toEqual({ checks: [], canceled: [] });
  expect(
    await next.evaluate(
      () =>
        (window as unknown as { readinessRevisionFixture: RevisionFixture })
          .readinessRevisionFixture.starts,
    ),
  ).toBe(0);
  expect(errors).toEqual([]);
  await next.screenshot({ path: test.info().outputPath("training-selection-restored.png") });
});
