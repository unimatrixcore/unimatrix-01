import { expect, test } from "@playwright/test";
import { installLabFixture } from "./fixture.js";

test("retains both workspaces across rail and history transitions", async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      const counts = { initial: 0, overlays: 0 };
      Object.assign(window, { transitionCounts: counts });
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.path === "/api/initial_data") counts.initial++;
        return previous(request);
      };
    }).toString()})();`,
  });
  await page.goto("/collection");
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  await page.evaluate(() => {
    (window as unknown as { tabMarker: number }).tabMarker = 42;
    const counts = (window as unknown as { transitionCounts: { overlays: number } })
      .transitionCounts;
    const overlay = document.getElementById("loading-overlay")!;
    new MutationObserver((records) => {
      if (
        overlay.classList.contains("active") ||
        records.some((record) => record.oldValue?.split(/\s+/).includes("active"))
      )
        counts.overlays++;
    }).observe(overlay, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
  });
  const rail = page
    .getByRole("navigation")
    .filter({ has: page.getByRole("link", { name: "Gameplay" }) });
  await rail.getByRole("link", { name: "Gameplay" }).click();
  await expect(page).toHaveURL(/\/gameplay$/);
  await expect(page.locator(".gameplay-workspace")).toBeVisible();
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  await page.getByRole("radio", { name: "Frames view" }).click();
  await rail.getByRole("link", { name: "OCR Data" }).click();
  await expect(page.locator("#section-ocr-data")).toBeVisible();
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { tabMarker: number }).tabMarker))
    .toBe(42);
  await page.goBack();
  await expect(page.locator(".gameplay-workspace")).toBeVisible();
  await expect(page.getByRole("radio", { name: "Frames view" })).toBeChecked();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { transitionCounts: { initial: number; overlays: number } })
          .transitionCounts,
    ),
  ).toEqual({ initial: 1, overlays: 0 });
  await expect(page.getByText(/Session Auto-Restored/)).toHaveCount(0);
});

test("cold Gameplay starts without initializing OCR, then retains OCR after first entry", async ({
  page,
}) => {
  await page.addInitScript({ content: `(${installLabFixture.toString()})();` });
  await page.goto("/gameplay");
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  expect(await page.evaluate(() => !!window.pokerOcrReady)).toBe(false);
  await page.getByRole("link", { name: "OCR Data" }).click();
  await expect(page.locator("#section-ocr-data")).toBeVisible();
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  expect(await page.evaluate(() => !!window.pokerOcrReady)).toBe(true);
  await page.getByRole("link", { name: "Gameplay" }).click();
  await page.getByRole("link", { name: "OCR Data" }).click();
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
});

test("Back during held OCR initialization keeps Gameplay and its URL", async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      const gate = { requested: false, release: false, calls: 0 };
      const sample = {
        id: "pot",
        sample_key: "locked-review-pot",
        label: "Pot: G 10 BB",
        reviewed: true,
        base64_image: "",
        image_url: "",
      };
      const summary = { total: 1, pending: 0, reviewed: 1, captures: 1, revision: 1 };
      Object.assign(window, { ocrGate: gate });
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.path === "/api/initial_data") {
          gate.calls++;
          gate.requested = true;
          while (!gate.release) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const response = (await previous(request)) as {
          status: number;
          headers: Record<string, string>;
          body: Record<string, unknown>;
        };
        if (request.path === "/api/initial_data")
          response.body = {
            ...response.body,
            session: {
              queue_mode: "paged",
              queue_summary: summary,
              review_batch: { mode: "stream", batch_id: "locked-review", next_cursor: null },
              review_stats: { total: 1, pending: 0 },
              frames: [],
              pool: [sample],
              labelingUnlocked: true,
              reviewUnlocked: true,
              currentReviewIdx: 0,
              queueLastCommitReceipt: "preserved-receipt",
            },
          };
        if (
          request.query.background_page === "1" &&
          ["/api/db_entries", "/api/queue/review/items"].includes(request.path)
        )
          response.body = {
            items:
              request.path === "/api/db_entries"
                ? [{ filename: "pot.png", id: "pot", label: "Pot: G 10 BB" }]
                : [sample],
            nextCursor: null,
            hasMore: false,
            total: 1,
            meta: { summary },
          };
        return response;
      };
    }).toString()})();`,
  });
  await page.goto("/gameplay");
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  await page.getByRole("link", { name: "OCR Data" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { ocrGate: { requested: boolean } }).ocrGate.requested,
      ),
    )
    .toBe(true);
  await page.goBack();
  await expect(page).toHaveURL(/\/gameplay$/);
  await expect(page.locator(".gameplay-workspace")).toBeVisible();
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  expect(
    await page.evaluate(
      () => (window as unknown as { ocrGate: { release: boolean } }).ocrGate.release,
    ),
  ).toBe(false);
  await page.evaluate(() => {
    (window as unknown as { ocrGate: { release: boolean } }).ocrGate.release = true;
  });
  await expect(page.locator("#collector-workspace")).toHaveClass(/ready/);
  await expect(page).toHaveURL(/\/gameplay$/);
  await expect(page.locator(".gameplay-workspace")).toBeVisible();
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  await page.goForward();
  await expect(page.locator("#section-ocr-data")).toBeVisible();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.locator("#view-session-review")).toBeVisible();
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  expect(
    await page.evaluate(() => (window as unknown as { ocrGate: { calls: number } }).ocrGate.calls),
  ).toBe(1);
});

test("restores each workspace's scroll position after a rail round trip", async ({ page }) => {
  await page.addInitScript({ content: `(${installLabFixture.toString()})();` });
  await page.goto("/collection");
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.style.height = "3000px";
    document.getElementById("view-collection")!.append(spacer);
    document.getElementById("main-content")!.scrollTop = 400;
  });
  await expect.poll(() => page.locator("#main-content").evaluate((el) => el.scrollTop)).toBe(400);
  await page.getByRole("link", { name: "Gameplay" }).click();
  await expect(page.locator(".gameplay-workspace")).toBeVisible();
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".gameplay-workspace")!.style.minHeight = "3000px";
    document.getElementById("main-content")!.scrollTop = 200;
  });
  await expect.poll(() => page.locator("#main-content").evaluate((el) => el.scrollTop)).toBe(200);
  await page.getByRole("link", { name: "OCR Data" }).click();
  await expect.poll(() => page.locator("#main-content").evaluate((el) => el.scrollTop)).toBe(400);
  await page.getByRole("link", { name: "Gameplay" }).click();
  await expect.poll(() => page.locator("#main-content").evaluate((el) => el.scrollTop)).toBe(200);
});

test("a failed stop after in-flight session creation keeps Gameplay active", async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      const gate = { requested: false, release: false, stopped: false };
      Object.assign(window, { captureGate: gate });
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.path === "/api/gameplay/sessions") {
          gate.requested = true;
          while (!gate.release) await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            status: 200,
            headers: {},
            body: {
              session: {
                id: "pending",
                name: "Pending",
                source: "TEST-1",
                interval_ms: 1000,
                status: "paused",
                created_at: "2026-11-12T00:00:00Z",
                frame_count: 0,
                hand_count: 0,
              },
            },
          };
        }
        if (request.path === "/api/gameplay/sessions/pending/stop") {
          gate.stopped = true;
          return { status: 500, headers: {}, body: { error: "Stop failed" } };
        }
        if (request.path.startsWith("/api/gameplay/sessions/pending"))
          return {
            status: 200,
            headers: {},
            body:
              request.query.background_page === "1"
                ? { items: [], nextCursor: null, hasMore: false, total: 0, meta: {} }
                : { frames: [] },
          };
        return previous(request);
      };
    }).toString()})();`,
  });
  await page.goto("/gameplay");
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  await page.keyboard.press("c");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { captureGate: { requested: boolean } }).captureGate.requested,
      ),
    )
    .toBe(true);
  await page.getByRole("link", { name: "OCR Data" }).click();
  await page.evaluate(() => {
    (window as unknown as { captureGate: { release: boolean } }).captureGate.release = true;
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { captureGate: { stopped: boolean } }).captureGate.stopped,
      ),
    )
    .toBe(true);
  await expect(page.locator(".gameplay-workspace")).toBeVisible();
  await expect(page).toHaveURL(/\/gameplay$/);
  await expect(page.getByText("Stop failed").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Recording session", exact: true })).toHaveText(
    "Pending",
  );
  await expect(page.getByRole("radio", { name: "Frames view", exact: true })).toBeEnabled();
});

test("a dataset switch completing behind Gameplay defers its OCR location", async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      const gate = { requested: false, release: false };
      Object.assign(window, { datasetGate: gate });
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.path === "/api/datasets" && request.query.background_page === "1")
          return {
            status: 200,
            headers: {},
            body: {
              items: [
                { id: "fixture", name: "First dataset", archived: false },
                { id: "second", name: "Second dataset", archived: false },
              ],
              nextCursor: null,
              hasMore: false,
              total: 2,
              meta: { default_dataset_id: "fixture" },
            },
          };
        if (request.path === "/api/initial_data" && request.headers["x-dataset-id"] === "second") {
          gate.requested = true;
          while (!gate.release) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return previous(request);
      };
    }).toString()})();`,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/gameplay");
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  await page.getByRole("link", { name: "OCR Data" }).click();
  await expect(page.locator("#collector-workspace")).toHaveClass(/ready/);
  await page.getByRole("button", { name: "Working dataset", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Second dataset", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { datasetGate: { requested: boolean } }).datasetGate.requested,
      ),
    )
    .toBe(true);
  await page.goBack();
  await expect(page.locator(".gameplay-workspace")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { datasetGate: { release: boolean } }).datasetGate.release = true;
  });
  await expect
    .poll(() => page.evaluate(() => window.pokerOcrDeferredLocation?.path))
    .toBe("/collection");
  await expect(page).toHaveURL(/\/gameplay$/);
  await expect(page.locator(".gameplay-workspace")).toBeVisible();
  await page.getByRole("link", { name: "OCR Data" }).click();
  await expect(page).toHaveURL(/\/collection$/);
  await expect(page.getByRole("button", { name: "Working dataset", exact: true })).toHaveText(
    "Second dataset",
  );
  expect(errors).toEqual([]);
});

test("failed first OCR startup offers retry", async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.path === "/api/initial_data")
          return { status: 500, headers: {}, body: { error: "Initialization failed" } };
        return previous(request);
      };
    }).toString()})();`,
  });
  await page.goto("/gameplay");
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  await page.getByRole("link", { name: "OCR Data" }).click();
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
});

test("OCR history navigation during cold startup clears the completed watchdog", async ({
  page,
}) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      const gate = { requested: false, release: () => {} };
      Object.assign(window, { startupHistoryGate: gate });
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.path === "/api/initial_data") {
          gate.requested = true;
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        return previous(request);
      };
    }).toString()})();`,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/gameplay");
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  await page.clock.install();
  await page.evaluate(() => {
    history.replaceState({ view: "collection" }, "", "/collection");
    history.pushState({ view: "collection" }, "", "/collection");
    history.pushState({ pokerGameplay: true }, "", "/gameplay");
  });
  await page.goBack();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { startupHistoryGate: { requested: boolean } }).startupHistoryGate
            .requested,
      ),
    )
    .toBe(true);
  await page.goBack();
  await page.evaluate(() => {
    (
      window as unknown as { startupHistoryGate: { release: () => void } }
    ).startupHistoryGate.release();
  });
  await expect(page.locator("#collector-workspace")).toHaveClass(/ready/);
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  await page.evaluate(() => window.startPokerOcr());
  await page.clock.runFor(16000);
  expect(await page.evaluate(() => !!window.pokerStartupTimedOut)).toBe(false);
  await expect(page.getByText("The first view timed out.")).toHaveCount(0);
  await expect(page.locator("#view-collection")).toBeVisible();
  expect(errors).toEqual([]);
});

test("capture shortcuts only reach the active workspace", async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      const calls: string[] = [];
      Object.assign(window, { captureCalls: calls });
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.path === "/api/capture" || request.path === "/api/gameplay/sessions")
          calls.push(request.path);
        return previous(request);
      };
    }).toString()})();`,
  });
  await page.goto("/collection");
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  await page.getByRole("link", { name: "Gameplay" }).click();
  await expect(page.locator(".gameplay-workspace")).toBeVisible();
  await page.keyboard.press("c");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { captureCalls: string[] }).captureCalls))
    .toEqual(["/api/gameplay/sessions"]);
});
