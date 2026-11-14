import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { installLabFixture } from "./fixture.js";

function installRestartFixture() {
  const previous = window.__POKER_LAB_TEST_INVOKE__!;
  const sessions = [0, 1].map((n) => ({
    id: `session-${n}`,
    name: `Recording ${n}`,
    source: "TEST-1",
    interval_ms: 1000,
    status: "stopped",
    created_at: "2026-11-13T00:00:00Z",
    frame_count: 30,
    hand_count: 1,
  }));
  const runs = Array.from({ length: 30 }, (_, n) => ({
    id: `run-${n}`,
    version: n + 1,
    display_name: `Version ${n + 1}`,
    created_at: 1700000000000 + n,
    status: "completed",
    stage: "completed",
    collections: ["fixture"],
    epochs: 6,
  }));
  const crop = (n: number) => ({
    queue_id: n + 1,
    sample_key: `crop-${n}`,
    id: "seats[1].status",
    label: "",
    reviewed: false,
    source: "TEST-1",
    image_url: "/restart-crop.svg",
    base64_image: "",
  });
  const summary = { total: 80, pending: 80, reviewed: 0, captures: 1, revision: 1 };
  const frame = (n: number, session = "session-1") => ({
    id: `frame-${n}`,
    session_id: session,
    hand_id: "42",
    captured_at: "2026-11-13T00:00:00Z",
    image_url: "/restart-crop.svg",
    width: 160,
    height: 80,
    ocr_status: "complete",
    error: null,
    results: {},
    config_snapshot: { regions: {} },
  });
  const success = (body: unknown) => ({ status: 200, headers: {}, body });
  Object.assign(window, { restartMutations: [] as string[] });
  window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
    if (request.method === "POST")
      (window as unknown as { restartMutations: string[] }).restartMutations.push(request.path);
    if (request.path === "/api/training") {
      await new Promise((resolve) => setTimeout(resolve, 75));
      return success({
        runs,
        setup: { ready: true },
        collections: [],
        gpu_status: {
          checked_at: Date.now(),
          devices: [{ host: "local", gpu: "Fixture GPU", ready: true }],
        },
      });
    }
    if (request.path === "/api/training/probe") return success({ checking: false });
    if (request.path.startsWith("/api/training/run-"))
      return success({ run: runs.find((run) => run.id === request.path.split("/").at(-1)) });
    if (request.path === "/api/gameplay") return success({ sessions });
    if (request.path.startsWith("/api/gameplay/sessions/")) {
      const id = request.path.split("/")[4];
      if (request.path.endsWith("/frames"))
        return success({ frames: Array.from({ length: 30 }, (_, n) => frame(n, id)), total: 30 });
      return success({
        session: sessions.find((session) => session.id === id),
        hands: [
          {
            hand_id: "42",
            frame_count: 30,
            first_at: "2026-11-13T00:00:00Z",
            last_at: "2026-11-13T00:00:00Z",
          },
        ],
      });
    }
    if (request.path.startsWith("/api/gameplay/frames/"))
      return success({ frame: frame(Number(request.path.split("-").at(-1))) });
    if (request.path === "/api/model_suggestion")
      return success({
        prediction: { id: "fresh-status", text: "Fold", raw_text: "Fold", schema_valid: true },
      });
    if (request.path === "/api/label_history") return success({ history: [], items: [] });
    if (request.path === "/api/queue" && request.query.background_page === "1")
      return success({
        items: Array.from({ length: 80 }, (_, n) => crop(n)),
        nextCursor: null,
        hasMore: false,
        total: 80,
        meta: { summary },
      });
    if (request.path === "/api/initial_data") {
      const result = (await previous(request)) as {
        status: number;
        headers: Record<string, string>;
        body: Record<string, unknown>;
      };
      const labeling = location.pathname.startsWith("/labeling");
      return {
        ...result,
        body: {
          ...result.body,
          session: labeling
            ? { frames: [], pool: [crop(0), crop(1)], labelingUnlocked: true, currentReviewIdx: 0 }
            : { queue_mode: "paged", frames: [], pool: [], queue_summary: summary },
          collection_page: {
            items: Array.from({ length: 80 }, (_, n) => crop(n)),
            next_cursor: null,
            summary,
          },
        },
      };
    }
    return previous(request);
  };
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript({
    content: `(${installLabFixture.toString()})();(${installRestartFixture.toString()})();`,
  });
  await context.route("**/restart-crop.svg**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#222"/><text x="10" y="40" fill="white">Fold</text></svg>',
    }),
  );
});

async function restart(context: BrowserContext, page: Page) {
  await page.close();
  const next = await context.newPage();
  await next.goto("/");
  return next;
}

test("fresh native root restores Training version and version-rail scroll after asynchronous data loads", async ({
  context,
  page,
}) => {
  await page.goto("/training");
  const version = page
    .locator(".training-version")
    .filter({ has: page.getByText("Version 2", { exact: true }) });
  await version.click();
  await expect(version).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-training-scroll="versions"]').evaluate((region) => {
    region.scrollTop = 200;
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            JSON.parse(localStorage.getItem("poker-lab:workspace:v1") || "{}") as {
              trainingPanes?: { versions?: { top: number } };
            }
          ).trainingPanes?.versions?.top,
      ),
    )
    .toBe(200);
  const next = await restart(context, page);
  await expect(next).toHaveURL(/\/training$/);
  await expect(
    next.locator(".training-version").filter({ has: next.getByText("Version 2", { exact: true }) }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() =>
      next.locator('[data-training-scroll="versions"]').evaluate((region) => region.scrollTop),
    )
    .toBe(200);
  expect(await next.evaluate(() => sessionStorage.length)).toBe(0);
  expect(
    await next.evaluate(() =>
      (window as unknown as { restartMutations: string[] }).restartMutations.filter(
        (path) => path === "/api/training" || path.includes("/ai-review/jobs"),
      ),
    ),
  ).toEqual([]);
  await next.screenshot({ path: test.info().outputPath("training-restored.png") });
});

test("fresh native root restores Gameplay recording, Frames view and hand without starting capture", async ({
  context,
  page,
}) => {
  await page.goto("/gameplay");
  await page.getByRole("button", { name: "Recording session", exact: true }).click();
  await page.getByRole("button", { name: "Recording 1 · 30 frames", exact: true }).click();
  await page.getByRole("radio", { name: "Frames view", exact: true }).click();
  await page.getByRole("button", { name: "Recorded hand", exact: true }).click();
  await page.getByRole("button", { name: "Hand #42 · 30", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            JSON.parse(localStorage.getItem("poker-lab:workspace:v1") || "{}") as {
              gameplay?: unknown;
            }
          ).gameplay,
      ),
    )
    .toEqual({ sessionId: "session-1", view: "frames", hand: "42" });
  await page.locator("#main-content").evaluate((region) => {
    region.scrollTop = 50;
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            JSON.parse(localStorage.getItem("poker-lab:workspace:v1") || "{}") as {
              scroll?: { gameplay?: { top: number } };
            }
          ).scroll?.gameplay?.top,
      ),
    )
    .toBe(50);
  const next = await restart(context, page);
  await expect(next).toHaveURL(/\/gameplay$/);
  await expect(next.getByRole("radio", { name: "Frames view", exact: true })).toBeChecked();
  await expect(next.getByRole("button", { name: "Recording session", exact: true })).toHaveText(
    "Recording 1",
  );
  await expect(next.getByRole("button", { name: "Recorded hand", exact: true })).toHaveText(
    "Hand #42",
  );
  await expect(next.locator("#loading-overlay")).not.toHaveClass(/active/);
  await expect
    .poll(() => next.locator("#main-content").evaluate((region) => region.scrollTop))
    .toBe(50);
  expect(
    await next.evaluate(() =>
      (window as unknown as { restartMutations: string[] }).restartMutations.filter(
        (path) => path.endsWith("/capture") || path.endsWith("/start"),
      ),
    ),
  ).toEqual([]);
  await next.screenshot({ path: test.info().outputPath("gameplay-restored.png") });
});

test("fresh native root restores the labeling position while explicit Collection wins", async ({
  context,
  page,
}) => {
  await page.goto("/labeling/2");
  await expect(page.locator("#review-idx")).toHaveText("2");
  const next = await restart(context, page);
  await expect(next).toHaveURL(/\/labeling\/2$/);
  await expect(next.locator("#review-idx")).toHaveText("2");
  await next.goto("/collection");
  await expect(next).toHaveURL(/\/collection$/);
  await expect(next.locator("#view-collection")).toBeVisible();
});

test("fresh native window restores Collection scroll from its durable mirror", async ({
  context,
  page,
}) => {
  await page.goto("/collection");
  await expect(page.locator("#collector-workspace")).toHaveClass(/ready/);
  await page.locator("#main-content").evaluate((region) => {
    region.scrollTop = 500;
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            JSON.parse(localStorage.getItem("collector:current-page-scroll:v1") || "{}") as {
              top?: number;
            }
          ).top,
      ),
    )
    .toBe(500);
  const next = await restart(context, page);
  await expect(next.locator("#collector-workspace")).toHaveClass(/ready/);
  await expect(next.locator("#loading-overlay")).not.toHaveClass(/active/);
  await expect
    .poll(() => next.locator("#main-content").evaluate((region) => region.scrollTop))
    .toBe(500);
  await next.screenshot({ path: test.info().outputPath("collection-restored.png") });
});
