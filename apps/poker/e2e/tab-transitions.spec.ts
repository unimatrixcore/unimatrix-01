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
