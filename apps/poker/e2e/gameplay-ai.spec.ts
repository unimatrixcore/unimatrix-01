import { expect, test, type Page } from "@playwright/test";
import { installLabFixture } from "./fixture";

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  Object.assign(page, { gameplayConsoleErrors: errors });
});
test.afterEach(({ page }) => {
  expect((page as Page & { gameplayConsoleErrors: string[] }).gameplayConsoleErrors).toEqual([]);
});

async function installReviewFixture(page: Page, initialState = "completed") {
  await page.addInitScript(installLabFixture);
  await page.addInitScript((initialState: string) => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    const crop =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="50"><rect width="480" height="50" fill="#153c34"/><g fill="white" font-family="monospace" font-size="23"><text x="12" y="33">355.6 BB</text><text x="300" y="33">22 BB</text></g></svg>',
      );
    const session = {
      id: "s0",
      name: "11/13/26 - Tigard #17",
      source: "TEST-1",
      interval_ms: 1000,
      status: "stopped",
      created_at: "2026-11-14T05:31:01Z",
      frame_count: 332,
      hand_count: 9,
    };
    const frame = {
      id: "f0",
      session_id: "s0",
      hand_id: "842601",
      captured_at: "2026-11-14T05:32:01Z",
      ocr_status: "complete",
      error: null,
      image_url: crop,
      width: 1920,
      height: 1080,
      results: {},
      config_snapshot: { regions: {} },
    };
    const verification = {
      region_profile_id: "current-ledger-profile",
      status: "partial",
      total: 159,
      verified: 149,
      unverified: 0,
      needs_review: 0,
      unsupported: 10,
    };
    Object.assign(window, {
      reviewFrameVerification: verification,
      reviewFrameReads: 0,
      reviewHandId: "842601",
    });
    const currentFrame = () => ({
      ...frame,
      captured_hand_id: frame.hand_id,
      hand_id: (window as unknown as { reviewHandId: string }).reviewHandId,
      verification: (window as unknown as { reviewFrameVerification: typeof verification })
        .reviewFrameVerification,
    });
    const rows = Array.from({ length: 350 }, (_, i) => ({
      id: `o${i}`,
      work_key: `work-${i}`,
      occurrence_count: 1,
      representative_occurrence_id: `o${i}`,
      conflicting_labels: [],
      frame_id: `f${i}`,
      region_id: i % 2 ? "seat.2.name" : "seat.4.bet",
      category: i % 2 ? "name" : "bet",
      label: i % 2 ? "milkyway" : "G 355.6 BB",
      original_label: i % 2 ? "mi1kyway" : "355.6 BE",
      state: "flagged",
      reason: i % 2 ? "Ambiguous character" : "Trailing unit differs",
      crop_url: crop,
      image_url: crop,
      cache_kind: "miss",
      ...(i === 0
        ? {
            guide: {
              policy: "source_css_target_anchor_v1",
              anchor: { x: 12, y: 25 },
              slot_polygon: [
                { x: 12, y: 8 },
                { x: 210, y: 8 },
                { x: 210, y: 40 },
                { x: 12, y: 40 },
              ],
              alignment: "left",
              family: "bet",
              source: "css_slot",
              crop_width: 480,
              crop_height: 50,
              visible_pixel_rect: { x: 0, y: 0, width: 480, height: 50 },
            },
          }
        : {}),
      revision: 0,
    }));
    const scope = {
      session_id: "s0",
      frame_count: 332,
      occurrences: 1842,
      unique_crops: 406,
      exact_cache_hits: 1052,
      ambiguous: 3,
      profile_id: "profile",
    };
    const control = {
      id: "j0",
      state: initialState,
      autoCorrect: true,
      maxRequests: 100,
      itemReads: 0,
    };
    Object.assign(window, { reviewControl: control });
    const posts: { path: string; body: unknown }[] = [];
    Object.assign(window, { reviewPosts: posts, rejectReview: false });
    const job = () => ({
      id: control.id,
      state: control.state,
      auto_correct: control.autoCorrect,
      max_requests: control.maxRequests,
      ...(control.state === "preparing" || control.state === "paused"
        ? { preparation: { processed_frames: 125, total_frames: 332 } }
        : {}),
      scope,
      revision: rows.reduce((n, row) => Math.max(n, row.revision), 0),
      counts: {
        total: 1842,
        pending: 406,
        verified: 1000,
        corrected: 82,
        manual: rows.filter((row) => row.state === "manual").length,
        needs_review: 350,
        ambiguous: 3,
        error: 1,
        frames_completed: 238,
        frames_total: 332,
      },
      group_counts: {
        total: 350,
        pending: 0,
        verified: 0,
        corrected: 0,
        manual: rows.filter((row) => row.state === "manual").length,
        needs_review: rows.filter((row) => row.state === "flagged").length,
        ambiguous: 0,
        error: 0,
        frames_completed: 238,
        frames_total: 332,
      },
      usage: {
        exact_cache_hits: 1052,
        near_cache_hits: 0,
        requests: 32,
        input_tokens: 5000,
        output_tokens: 1800,
      },
    });
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      const ok = (body: unknown) => ({ status: 200, headers: {}, body });
      if (request.path.startsWith("/api/gameplay/ai/")) {
        if (request.method === "POST") posts.push({ path: request.path, body: request.body });
        if (request.path.endsWith("/status"))
          return ok({ job: control.state === "absent" ? null : job() });
        if (request.path.endsWith("/items")) {
          control.itemReads++;
          const filter = request.query.filter;
          const filtered = rows.filter(
            (row) =>
              filter === "all" ||
              (filter === "manual"
                ? row.state === "flagged"
                : filter === "completed"
                  ? row.state === "manual"
                  : row.state === filter),
          );
          const offset = Number(request.query.cursor || 0),
            limit = Number(request.query.limit || 100);
          const end = Math.min(filtered.length, offset + limit);
          return ok({
            items: filtered.slice(offset, end),
            nextCursor: end < filtered.length ? String(end) : null,
            hasMore: end < filtered.length,
            total: filtered.length,
            meta: {},
          });
        }
        if (request.path.endsWith("/review")) {
          if ((window as unknown as { rejectReview: boolean }).rejectReview)
            return {
              status: 409,
              headers: {},
              body: { error: "Reading changed; reload before correcting" },
            };
          const body = request.body as {
            occurrence_id: string;
            label: string;
            action: string;
            expected_revision: number;
          };
          const row = rows.find((item) => item.id === body.occurrence_id)!;
          row.label = body.label;
          row.state = body.action;
          row.revision++;
          return ok({ item: row, revision: row.revision, affected_count: 8 });
        }
        if (request.path.endsWith("/prepare")) {
          const body = request.body as {
            review_after_prepare?: boolean;
            auto_correct?: boolean;
            max_requests?: number;
          };
          if (body.review_after_prepare) {
            control.autoCorrect = body.auto_correct ?? true;
            control.maxRequests = body.max_requests ?? 100;
            if (control.state === "quarantined") {
              control.id = "current-policy-job";
              control.state = "prepared";
            } else control.state = control.state === "prepared" ? "running" : "preparing";
          }
          return ok({
            scope,
            run_id: "extraction-run",
            job_id: body.review_after_prepare ? control.id : null,
          });
        }
        if (request.path.endsWith("/start") || request.path.endsWith("/resume")) {
          control.state = "running";
          return ok({ job: job() });
        }
        if (request.path.endsWith("/stop")) {
          control.state = control.state === "preparing" ? "paused" : "cancelled";
          return ok({ job: job() });
        }
      }
      if (request.path === "/api/gameplay") return ok({ sessions: [session] });
      if (request.path === "/api/gameplay/sessions/s0")
        return ok({
          session,
          hands: [
            {
              hand_id: currentFrame().hand_id,
              frame_count: 332,
              first_at: frame.captured_at,
              last_at: frame.captured_at,
            },
          ],
        });
      if (request.path === "/api/gameplay/sessions/s0/frames")
        return ok({ frames: [currentFrame()], total: 1 });
      if (request.path.startsWith("/api/gameplay/frames/")) {
        (window as unknown as { reviewFrameReads: number }).reviewFrameReads++;
        return ok({ frame: currentFrame() });
      }
      if (request.path === "/api/gameplay/sessions/s0/rename")
        return ok({
          session: { ...session, name: String((request.body as { name: string }).name) },
        });
      return previous(request);
    };
  }, initialState);
}

async function expectManualReviewHidden(page: Page) {
  await expect(page.getByRole("region", { name: "Review queue" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Review filters" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "OCR review crops" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save and next" })).toHaveCount(0);
}

test("quarantine rechecks explicitly into a new job and preserves drafts through the completion gate", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page, "quarantined");
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  await expect(page.getByText("Quarantined", { exact: true })).toBeVisible();
  const recheck = page.getByRole("button", { name: "Recheck review" });
  await recheck.hover();
  await expect(page.getByRole("tooltip", { name: "Recheck review", exact: true })).toBeVisible();
  await expectManualReviewHidden(page);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts))
    .toEqual([]);
  await page.getByText("Review details", { exact: true }).click();
  const limit = page.getByRole("spinbutton", { name: "Request limit" });
  await limit.fill("240");
  await page.getByRole("button", { name: "Auto-correction enabled" }).click();
  await page.getByRole("radio", { name: "Frames view" }).click();
  await page.getByRole("radio", { name: "AI view" }).click();
  await page.getByText("Review details", { exact: true }).click();
  await expect(limit).toHaveValue("240");
  await expect(page.getByRole("button", { name: "Auto-correction disabled" })).toBeEnabled();
  expect(
    await page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts),
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("poker-quarantined-recheck.png"),
    fullPage: true,
  });
  await recheck.click();
  await expect(page.getByText("prepared", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expectManualReviewHidden(page);
  expect(
    await page.evaluate(
      () => (window as unknown as { reviewControl: { id: string } }).reviewControl.id,
    ),
  ).toBe("current-policy-job");
  await page.evaluate(() => {
    (window as unknown as { reviewControl: { state: string } }).reviewControl.state = "running";
  });
  await expect(page.getByText("ChatGPT review", { exact: true })).toBeVisible();
  await expectManualReviewHidden(page);
  await page.evaluate(() => {
    (window as unknown as { reviewControl: { state: string } }).reviewControl.state = "completed";
  });
  await expect(page.getByRole("region", { name: "Review queue" })).toBeVisible();
  await expect(limit).toHaveValue("240");
  await expect(page.getByRole("button", { name: "Auto-correction disabled" })).toBeEnabled();
  const reading = page.getByRole("textbox", { name: "Correct reading" });
  await reading.fill("355.5 BB");
  await page.getByRole("button", { name: "Refresh review" }).click();
  await expect(reading).toHaveValue("355.5 BB");
  expect(
    await page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts),
  ).toEqual([
    {
      path: "/api/gameplay/ai/prepare",
      body: {
        session_id: "s0",
        review_after_prepare: true,
        auto_correct: false,
        max_requests: 240,
        recover_from_job_id: "j0",
      },
    },
  ]);
  await page.setViewportSize({ width: 420, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath("poker-rechecked-completed-narrow.png"),
    fullPage: true,
  });
});

for (const state of ["preparing", "prepared", "running", "paused"] as const) {
  test(`${state} keeps manual queue, filter counters and inspector hidden`, async ({ page }) => {
    await installReviewFixture(page, state);
    await page.goto("/gameplay");
    await page.getByRole("radio", { name: "AI view" }).click();
    await expect(
      page.getByText(
        state === "preparing" ? "Extracting crops" : state === "running" ? "ChatGPT review" : state,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh review" })).toBeEnabled();
    await expectManualReviewHidden(page);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { reviewControl: { itemReads: number } }).reviewControl.itemReads,
      ),
    ).toBe(0);
  });
}

test("single Start snapshots auto-correction through extraction, ChatGPT, pause/resume and completion", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page, "absent");
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  await expect(page.getByText("Unverified", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Auto-correction enabled" }).click();
  await page.getByRole("button", { name: "Start review" }).click();
  await expect(page.getByText("Extracting crops", { exact: true })).toBeVisible();
  await expectManualReviewHidden(page);
  await page.evaluate(() => {
    (window as unknown as { reviewControl: { state: string } }).reviewControl.state = "running";
  });
  await page.getByRole("button", { name: "Refresh review" }).click();
  await expect(page.getByText("ChatGPT review", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Auto-correction disabled" })).toBeDisabled();
  await expectManualReviewHidden(page);
  await page.getByRole("button", { name: "Pause review" }).click();
  await expect(page.getByRole("button", { name: "Resume review" })).toBeEnabled();
  await expectManualReviewHidden(page);
  await page.getByRole("button", { name: "Resume review" }).click();
  await expect(page.getByText("ChatGPT review", { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "Frames view" }).click();
  await page.getByRole("radio", { name: "AI view" }).click();
  await expect(page.getByRole("button", { name: "Auto-correction disabled" })).toBeDisabled();
  await expectManualReviewHidden(page);
  await page.screenshot({
    path: testInfo.outputPath("poker-gameplay-ai-chatgpt.png"),
    fullPage: true,
  });
  await page.evaluate(() => {
    (window as unknown as { reviewControl: { state: string } }).reviewControl.state = "completed";
  });
  await page.getByRole("button", { name: "Refresh review" }).click();
  await expect(page.getByRole("region", { name: "Review queue" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Review filters" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveValue("G 355.6 BB");
  await expect(page.getByRole("button", { name: "Auto-correction disabled" })).toBeEnabled();
  expect(
    await page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts),
  ).toEqual([
    {
      path: "/api/gameplay/ai/prepare",
      body: {
        session_id: "s0",
        review_after_prepare: true,
        auto_correct: false,
        max_requests: 100,
      },
    },
    { path: "/api/gameplay/ai/stop", body: { job_id: "j0" } },
    { path: "/api/gameplay/ai/resume", body: { job_id: "j0", max_requests: 100 } },
  ]);
  await page.screenshot({
    path: testInfo.outputPath("poker-gameplay-ai-completed-gate.png"),
    fullPage: true,
  });
});

test("Frames accepts a response with the verification field actually absent", async ({ page }) => {
  await installReviewFixture(page);
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      const response = (await previous(request)) as {
        body: {
          frames?: Record<string, unknown>[];
          items?: Record<string, unknown>[];
          frame?: Record<string, unknown>;
        };
      };
      if (
        request.path === "/api/gameplay/sessions/s0/frames" ||
        request.path.startsWith("/api/gameplay/frames/")
      ) {
        for (const frame of response.body.frames ||
          response.body.items ||
          (response.body.frame ? [response.body.frame] : []))
          delete frame.verification;
      }
      return response;
    };
  });
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "Frames view" }).click();
  await expect(
    page.getByRole("list", { name: "Recorded frames" }).getByRole("listitem"),
  ).toHaveCount(1);
  await expect(
    page.locator(".gameplay-frame-card").getByText("Unverified OCR", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("frame ledger updates preserve scroll, overlay state, focus and recording edits", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page);
  await page.setViewportSize({ width: 1000, height: 500 });
  await page.goto("/gameplay");
  await expect(
    page.getByLabel("Frame verification: Partial · 149/159 · 10 unsupported"),
  ).toBeVisible();
  await page.setViewportSize({ width: 420, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath("poker-gameplay-ledger-badge-narrow.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1000, height: 500 });
  await page.getByRole("button", { name: "Toggle region overlay" }).click();
  await page.getByRole("button", { name: "Rename recording" }).click();
  const edit = page.getByLabel("Recording name to rename");
  await edit.fill("Keep this draft");
  const scroller = page.locator("#main-content");
  const top = await scroller.evaluate((element) => {
    element.scrollTop = 120;
    return element.scrollTop;
  });
  expect(top).toBeGreaterThan(40);
  await page.evaluate(() => {
    Object.assign(window, {
      reviewFrameVerification: {
        region_profile_id: "current-ledger-profile",
        status: "verified",
        total: 159,
        verified: 159,
        unverified: 0,
        needs_review: 0,
        unsupported: 0,
      },
    });
  });
  await expect(page.getByLabel("Frame verification: Verified · 159/159")).toBeVisible();
  await expect(edit).toHaveValue("Keep this draft");
  await expect(edit).toBeFocused();
  await expect(page.getByRole("button", { name: "Toggle region overlay" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(top);
  await edit.press("Escape");
  await page.getByLabel("Frame verification: Verified · 159/159").focus();
  await expect(page.getByRole("tooltip", { name: /Profile current-ledger-profile/ })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("poker-gameplay-ledger-badge.png"),
    fullPage: true,
  });
  const reads = await page.evaluate(
    () => (window as unknown as { reviewFrameReads: number }).reviewFrameReads,
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(2300);
  expect(
    await page.evaluate(() => (window as unknown as { reviewFrameReads: number }).reviewFrameReads),
  ).toBe(reads);
  expect(
    await page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts),
  ).toEqual([]);
});

test("leaving AI refreshes ledger cards, preserves valid hands and recovers removed hand filters", async ({
  page,
}) => {
  await installReviewFixture(page);
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "Frames view" }).click();
  await page.getByRole("button", { name: "Recorded hand", exact: true }).click();
  await page.getByRole("button", { name: "Hand #842601 · 332" }).click();
  await page.getByRole("radio", { name: "AI view" }).click();
  await page.evaluate(() => {
    Object.assign(window, {
      reviewFrameVerification: {
        region_profile_id: "current-ledger-profile",
        status: "verified",
        total: 159,
        verified: 159,
        unverified: 0,
        needs_review: 0,
        unsupported: 0,
      },
    });
  });
  await page.getByRole("radio", { name: "Frames view" }).click();
  await expect(page.getByRole("button", { name: "Recorded hand", exact: true })).toHaveText(
    "Hand #842601",
  );
  await expect(
    page.locator(".gameplay-frame-card").getByText("Verified · 159/159", { exact: true }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "AI view" }).click();
  await page.evaluate(() => Object.assign(window, { reviewHandId: "842602" }));
  await page.getByRole("radio", { name: "Frames view" }).click();
  await expect(page.getByRole("button", { name: "Recorded hand", exact: true })).toHaveText(
    "All frames",
  );
  await expect(
    page.locator(".gameplay-frame-card").getByText("Game #842602", { exact: true }),
  ).toBeVisible();
});

test("manual crop target uses the saved guide without covering either neighboring bet", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page);
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  const crop = page.getByRole("img", { name: "seat.4.bet crop with OCR target" });
  await expect(crop).toBeVisible();
  await crop.focus();
  await expect(page.getByRole("tooltip")).toHaveText("OCR target");
  const geometry = await crop.evaluate((element) => {
    const image = element.querySelector("image")!;
    return {
      pixels: [
        image.getAttribute("x"),
        image.getAttribute("y"),
        image.getAttribute("width"),
        image.getAttribute("height"),
      ],
      original: decodeURIComponent(image.getAttribute("href") || ""),
      markers: Array.from(element.querySelectorAll("path"), (path) => {
        const box = path.getBBox();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      }),
    };
  });
  expect(geometry.pixels).toEqual(["0", "0", "480", "50"]);
  expect(geometry.original).toContain("355.6 BB");
  expect(geometry.original).toContain("22 BB");
  expect(geometry.markers).toEqual([
    { x: 8, y: -10, width: 8, height: 8 },
    { x: -10, y: 21, width: 8, height: 8 },
  ]);
  await page.screenshot({
    path: testInfo.outputPath("poker-gameplay-ai-target-guide.png"),
    fullPage: true,
  });
});

test("durable preparation shows actual progress and can be paused without provider work", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page, "preparing");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  await expect(page.getByText("125 / 332 frames")).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Preparation progress" })).toHaveAttribute(
    "value",
    "125",
  );
  await expect(page.getByText(/frames verified/)).toHaveCount(0);
  await page.getByRole("button", { name: "Pause preparation" }).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Pause preparation");
  await page.screenshot({
    path: testInfo.outputPath("poker-gameplay-ai-preparing.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Pause preparation" }).click();
  await expect(page.getByRole("button", { name: "Resume preparation" })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { reviewPosts: { path: string }[] }).reviewPosts,
    ),
  ).toEqual([{ path: "/api/gameplay/ai/stop", body: { job_id: "j0" } }]);
  expect(errors).toEqual([]);
});

test("completed review eagerly fetches pages and refreshes persisted crops without losing edits", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page);
  await page.addInitScript(() => {
    Object.assign(window, { prepRevision: 0, prepReads: [] });
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      const response = (await previous(request)) as { body: unknown };
      const state = window as unknown as {
        prepRevision: number;
        prepReads: { cursor: string; limit: number; count: number }[];
      };
      if (request.path === "/api/gameplay/ai/status") {
        const body = response.body as {
          job: { revision: number };
        };
        body.job.revision = state.prepRevision;
      }
      if (request.path === "/api/gameplay/ai/items") {
        const body = response.body as { items: Record<string, unknown>[] };
        state.prepReads.push({
          cursor: request.query.cursor || "0",
          limit: Number(request.query.limit),
          count: body.items.length,
        });
        for (const item of body.items) {
          item.crop_url = `/api/mock-preparation-crop/${String(item.id)}.svg`;
          if (item.id === "o0") {
            item.label = state.prepRevision ? "G 355.7 BB" : "G 355.6 BB";
            item.revision = state.prepRevision;
          }
        }
      }
      return response;
    };
  });
  const imageReads = new Set<string>();
  await page.route("**/api/mock-preparation-crop/*.svg", async (route) => {
    imageReads.add(new URL(route.request().url()).pathname);
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="50"><text x="12" y="33">G 355.6 BB</text></svg>',
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveValue("G 355.6 BB");
  const queue = page.getByRole("list", { name: "OCR review crops" });
  await expect(queue.getByRole("button").first()).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Set(
            (window as unknown as { prepReads: { cursor: string }[] }).prepReads.map(
              (read) => read.cursor,
            ),
          ).size,
      ),
    )
    .toBe(4);
  const mounted = await page.locator(".gameplay-ai-crop-row").count();
  expect(mounted).toBeLessThan(25);
  expect(await queue.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(page.locator(".gameplay-ai-crop-row img").first()).toHaveJSProperty(
    "naturalWidth",
    480,
  );
  const metrics = {
    reads: await page.evaluate(() => (window as unknown as { prepReads: unknown[] }).prepReads),
    mounted_rows: mounted,
    unique_crop_image_requests: imageReads.size,
    thumbnail_loading_attributes: await page
      .locator(".gameplay-ai-crop-row img")
      .evaluateAll((images) => [...new Set(images.map((image) => image.getAttribute("loading")))]),
    scroll_top: await queue.evaluate((element) => element.scrollTop),
  };
  expect(metrics.unique_crop_image_requests).toBeGreaterThan(0);
  expect(metrics.unique_crop_image_requests).toBeLessThanOrEqual(mounted + 1);
  expect(metrics.thumbnail_loading_attributes).toEqual(["lazy"]);
  await (
    await import("node:fs/promises")
  ).writeFile(
    testInfo.outputPath("preparation-loading-metrics.json"),
    JSON.stringify(metrics, null, 2),
  );
  await page.getByRole("textbox", { name: "Correct reading" }).fill("G 777.7 BB");
  await queue.evaluate((element) => {
    element.scrollTop = 120;
  });
  await page.evaluate(() => {
    (window as unknown as { prepRevision: number }).prepRevision++;
  });
  await expect(page.getByRole("button", { name: "Reload changed reading" })).toBeVisible();
  await expect(queue.getByRole("button").first()).toContainText("G 355.7 BB");
  await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveValue("G 777.7 BB");
  expect(await queue.evaluate((element) => element.scrollTop)).toBe(120);
  expect(
    await page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts),
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("poker-gameplay-ai-completed-populated.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

for (const recovery of ["persisted source", "quarantined candidate"]) {
  test(`reloaded paused recovery uses ${recovery} with the lowered preparation budget`, async ({
    page,
  }, testInfo) => {
    await installReviewFixture(page, "paused");
    await page.addInitScript((recovery) => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        const response = (await previous(request)) as {
          body: { job?: { scope: Record<string, unknown>; recovery_candidate_job_id?: string } };
        };
        if (request.path === "/api/gameplay/ai/status" && response.body.job) {
          if (recovery === "persisted source")
            response.body.job.scope.recover_from_job_id = "paid-source-job";
          else response.body.job.recovery_candidate_job_id = "paid-source-job";
        }
        return response;
      };
    }, recovery);
    const action = recovery === "persisted source" ? "Resume preparation" : "Recheck review";
    await page.goto("/gameplay");
    await page.getByRole("radio", { name: "AI view" }).click();
    await expect(page.getByRole("button", { name: action })).toBeEnabled();
    await page.reload();
    await expect(page.getByRole("button", { name: action })).toBeEnabled();
    expect(
      await page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts),
    ).toEqual([]);
    await page.getByText("Review details", { exact: true }).click();
    await page.getByRole("spinbutton", { name: "Request limit" }).fill("8");
    await page.getByRole("button", { name: action }).click();
    await expect(page.getByRole("button", { name: "Pause preparation" })).toBeEnabled();
    expect(
      await page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts),
    ).toEqual([
      {
        path: "/api/gameplay/ai/prepare",
        body: {
          session_id: "s0",
          review_after_prepare: true,
          auto_correct: true,
          max_requests: 8,
          recover_from_job_id: "paid-source-job",
        },
      },
    ]);
    await page.screenshot({
      path: testInfo.outputPath("paused-recovery-resumed.png"),
      fullPage: true,
    });
  });
}

test("preparation pause waits for durable acknowledgement and resume records automatic review intent", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page, "preparing");
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    const control = {
      state: "preparing",
      events: [] as { event: string; time: number; state?: string }[],
      release: () => {},
    };
    Object.assign(window, { prepControl: control });
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      if (request.path === "/api/gameplay/ai/stop") {
        control.events.push({ event: "stop_handler", time: performance.now() });
        (window as unknown as { reviewPosts: unknown[] }).reviewPosts.push({
          path: request.path,
          body: request.body,
        });
        await new Promise<void>((resolve) => {
          control.release = resolve;
        });
        control.events.push({ event: "stop_response", time: performance.now() });
        return previous({
          ...request,
          method: "GET",
          path: "/api/gameplay/ai/status",
          query: { session_id: "s0" },
          body: null,
        });
      }
      if (request.path === "/api/gameplay/ai/prepare") {
        control.state = "preparing";
        control.events.push({ event: "resume_preparation", time: performance.now() });
      }
      const response = (await previous(request)) as { body: unknown };
      if (request.path === "/api/gameplay/ai/status") {
        const body = response.body as { job: { state: string } };
        body.job.state = control.state;
        control.events.push({
          event: "status_response",
          state: control.state,
          time: performance.now(),
        });
      }
      return response;
    };
  });
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  const input = page.getByRole("textbox", { name: "Correct reading" });
  await expect(input).toHaveCount(0);
  await page.getByRole("button", { name: "Pause preparation" }).click();
  const pending = page.getByRole("button", { name: "Pausing preparation" });
  await expect(pending).toBeDisabled();
  await page.evaluate(() => {
    const control = (
      window as unknown as { prepControl: { events: { event: string; time: number }[] } }
    ).prepControl;
    control.events.push({ event: "pending_render", time: performance.now() });
  });
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { reviewPosts: { path: string }[] }).reviewPosts.filter((post) =>
          post.path.endsWith("/stop"),
        ).length,
    ),
  ).toBe(1);
  await page.evaluate(() => {
    (window as unknown as { prepControl: { release: () => void } }).prepControl.release();
  });
  await expect(pending).toBeDisabled();
  await expect(page.getByRole("button", { name: "Resume preparation" })).toHaveCount(0);
  await page.evaluate(() => {
    const control = (
      window as unknown as {
        prepControl: { state: string; events: { event: string; time: number }[] };
      }
    ).prepControl;
    control.state = "paused";
    control.events.push({ event: "durable_paused", time: performance.now() });
  });
  await expect(page.getByRole("button", { name: "Resume preparation" })).toBeEnabled();
  await expect(input).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as unknown as { prepControl: { events: { event: string; time: number }[] } }
    ).prepControl.events.push({ event: "paused_render", time: performance.now() }),
  );
  await page.getByRole("button", { name: "Resume preparation" }).click();
  await expect(page.getByRole("button", { name: "Pause preparation" })).toBeEnabled();
  await expect(input).toHaveCount(0);
  const posts = await page.evaluate(
    () => (window as unknown as { reviewPosts: { path: string; body: unknown }[] }).reviewPosts,
  );
  expect(posts.map((post) => post.path)).toEqual([
    "/api/gameplay/ai/stop",
    "/api/gameplay/ai/prepare",
  ]);
  expect(posts[1]?.body).toEqual({
    session_id: "s0",
    review_after_prepare: true,
    auto_correct: true,
    max_requests: 100,
  });
  const events = await page.evaluate(
    () => (window as unknown as { prepControl: { events: unknown[] } }).prepControl.events,
  );
  await (
    await import("node:fs/promises")
  ).writeFile(
    testInfo.outputPath("preparation-control-timeline.json"),
    JSON.stringify(events, null, 2),
  );
  await page.screenshot({
    path: testInfo.outputPath("poker-gameplay-ai-resumed-preparation.png"),
    fullPage: true,
  });
});

test("returning to prepared A after B never posts a duplicate handoff", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page, "prepared");
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    let activeStream = "s1";
    const providerStarts: string[] = [];
    const statusReads: string[] = [];
    Object.assign(window, { providerStarts, preparedStatusReads: statusReads });
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      const body = request.body as {
        session_id?: string;
        review_after_prepare?: boolean;
        auto_correct?: boolean;
      } | null;
      if (request.path === "/api/gameplay/ai/start")
        throw new Error("The client must not start a second provider worker");
      const routed = request.path.startsWith("/api/gameplay/sessions/s1")
        ? { ...request, path: request.path.replace("/sessions/s1", "/sessions/s0") }
        : request;
      const response = (await previous(routed)) as { body: unknown };
      if (request.path === "/api/gameplay") {
        const value = response.body as {
          sessions?: Record<string, unknown>[];
          items?: Record<string, unknown>[];
          total?: number;
        };
        const original = (value.sessions || value.items)![0]!;
        const sessions = [
          { ...original, name: "Recording A" },
          { ...original, id: "s1", name: "Recording B" },
        ];
        if (value.items) {
          value.items = sessions;
          value.total = sessions.length;
        } else value.sessions = sessions;
      }
      if (request.path.startsWith("/api/gameplay/sessions/s1")) {
        const value = response.body as {
          session?: Record<string, unknown>;
          frames?: Record<string, unknown>[];
          items?: Record<string, unknown>[];
        };
        if (value.session) value.session = { ...value.session, id: "s1", name: "Recording B" };
        for (const frame of value.frames ||
          (request.path.endsWith("/frames") ? value.items : undefined) ||
          [])
          frame.session_id = "s1";
      }
      if (request.path === "/api/gameplay/ai/status") {
        const session = request.query.session_id!;
        statusReads.push(session);
        const value = response.body as { job: { id: string; scope: { session_id: string } } };
        value.job.id = `run-${session}`;
        value.job.scope.session_id = session;
      }
      if (request.path === "/api/gameplay/ai/prepare") {
        if (body?.review_after_prepare !== true || body.auto_correct !== true)
          throw new Error("Missing durable review intent");
        activeStream = body.session_id!;
        providerStarts.push(activeStream);
        const value = response.body as { run_id: string; scope: { session_id: string } };
        value.run_id = `run-${activeStream}`;
        value.scope.session_id = activeStream;
      }
      return response;
    };
  });
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  await expect(page.getByRole("button", { name: "Start review" })).toHaveCount(0);
  await page.getByRole("button", { name: "Recording session", exact: true }).click();
  await page
    .getByRole("list", { name: "Recording sessions" })
    .getByRole("button", { name: /Recording B/ })
    .click();
  await expect(page.getByRole("button", { name: "Recording session", exact: true })).toHaveText(
    "Recording B",
  );
  await expect(page.getByRole("button", { name: "Start review" })).toHaveCount(0);
  await page.getByRole("button", { name: "Recording session", exact: true }).click();
  await page
    .getByRole("list", { name: "Recording sessions" })
    .getByRole("button", { name: /Recording A/ })
    .click();
  await expect(page.getByRole("button", { name: "Recording session", exact: true })).toHaveText(
    "Recording A",
  );
  await expect(page.getByRole("button", { name: "Start review" })).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { providerStarts: string[] }).providerStarts),
  ).toEqual([]);
  await page.getByRole("button", { name: "Refresh review" }).click();
  const proof = await page.evaluate(() => ({
    reads: (window as unknown as { preparedStatusReads: string[] }).preparedStatusReads,
    posts: (window as unknown as { reviewPosts: { path: string; body: unknown }[] }).reviewPosts,
    provider_starts: (window as unknown as { providerStarts: string[] }).providerStarts,
  }));
  expect(proof.reads.slice(0, 3)).toEqual(["s0", "s1", "s0"]);
  expect(proof.posts).toEqual([]);
  expect(proof.provider_starts).toEqual([]);
  await (
    await import("node:fs/promises")
  ).writeFile(
    testInfo.outputPath("prepared-reactivation-proof.json"),
    JSON.stringify(proof, null, 2),
  );
});

for (const view of ["ai", "games", "frames"] as const) {
  test(`${view} startup ignores an unrelated latest-frame read and stays ready during background refresh`, async ({
    page,
  }) => {
    await installReviewFixture(page, "preparing");
    await page.clock.install();
    await page.addInitScript((view) => {
      localStorage.setItem(
        "poker-lab:workspace:v1",
        JSON.stringify({ path: "/gameplay", gameplay: { sessionId: "s0", view } }),
      );
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      Object.assign(window, { unrelatedFrameReads: 0, releaseUnrelatedFrame: () => {} });
      const pending = new Promise<void>((resolve) => {
        Object.assign(window, { releaseUnrelatedFrame: resolve });
      });
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (
          request.path === "/api/gameplay/sessions/s0/frames" &&
          request.query.background_page !== "1"
        ) {
          (window as unknown as { unrelatedFrameReads: number }).unrelatedFrameReads++;
          await pending;
        }
        return previous(request);
      };
    }, view);
    await page.goto("/gameplay");
    if (view === "ai") await expect(page.getByText("125 / 332 frames")).toBeVisible();
    else
      await expect(
        page.getByRole("list", { name: view === "games" ? "Recorded games" : "Recorded frames" }),
      ).toBeVisible();
    await expect(page.locator("#loading-overlay")).toBeHidden({ timeout: 2000 });
    expect(
      await page.evaluate(
        () => (window as unknown as { unrelatedFrameReads: number }).unrelatedFrameReads,
      ),
    ).toBe(0);
    await page.clock.fastForward(11000);
    await expect(
      page.getByText("Loading the first view timed out. Retry the recordings list."),
    ).toHaveCount(0);
    await page.evaluate(() => {
      (window as unknown as { releaseUnrelatedFrame: () => void }).releaseUnrelatedFrame();
    });
    expect(
      await page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts),
    ).toEqual([]);
  });
}

test("recording startup reports a delayed required frame and clears its timeout after recovery", async ({
  page,
}) => {
  await installReviewFixture(page);
  await page.clock.install();
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.assign(window, {
      releaseRequiredFrame: () => {
        release();
      },
    });
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      if (
        request.path === "/api/gameplay/sessions/s0/frames" &&
        request.query.background_page !== "1"
      )
        await pending;
      return previous(request);
    };
  });
  await page.goto("/gameplay");
  await expect(page.getByRole("button", { name: "Recording session", exact: true })).toHaveText(
    "11/13/26 - Tigard #17",
  );
  await expect(page.locator("#loading-overlay")).toBeVisible();
  await page.clock.fastForward(11000);
  await expect(
    page.getByText("Loading the first view timed out. Retry the recordings list."),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { releaseRequiredFrame: () => void }).releaseRequiredFrame();
  });
  await expect(
    page.getByLabel("Frame verification: Partial · 149/159 · 10 unsupported"),
  ).toBeVisible();
  await expect(
    page.getByText("Loading the first view timed out. Retry the recordings list."),
  ).toHaveCount(0);
  await expect(page.locator("#loading-overlay")).toBeHidden();
});

for (const view of ["games", "frames", "ai"] as const) {
  test(`${view} initial loading stays inside its list viewport`, async ({ page }, testInfo) => {
    await installReviewFixture(page);
    await page.addInitScript((view) => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      let release = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      Object.assign(window, {
        releaseViewList: () => {
          release();
        },
      });
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        const held =
          view === "games"
            ? request.path === "/api/gameplay/sessions/s0" && request.query.background_page === "1"
            : view === "frames"
              ? request.path === "/api/gameplay/sessions/s0/frames" &&
                request.query.background_page === "1"
              : request.path === "/api/gameplay/ai/items";
        if (held) await pending;
        return previous(request);
      };
    }, view);
    await page.goto("/gameplay");
    await expect(page.locator("#loading-overlay")).toBeHidden();
    await page
      .getByRole("radio", {
        name: `${view === "ai" ? "AI" : view === "games" ? "Games" : "Frames"} view`,
      })
      .click();
    const list = page.getByRole("list", {
      name:
        view === "ai"
          ? "OCR review crops"
          : view === "games"
            ? "Recorded games"
            : "Recorded frames",
    });
    const host = list.locator("..");
    const status = host.getByRole("status");
    await expect(status).toHaveText("Loading…");
    const viewport = (await list.boundingBox())!,
      indicator = (await status.boundingBox())!;
    expect(indicator.y).toBeGreaterThanOrEqual(viewport.y);
    expect(indicator.y + indicator.height).toBeLessThanOrEqual(viewport.y + viewport.height);
    expect(indicator.y - viewport.y).toBeLessThan(20);
    await host.screenshot({ path: testInfo.outputPath(`poker-${view}-initial-loading.png`) });
    await page.evaluate(() => {
      (window as unknown as { releaseViewList: () => void }).releaseViewList();
    });
    await expect(list.getByRole("listitem").first()).toBeVisible();
    await expect(
      page.getByText("Loading the first view timed out. Retry the recordings list."),
    ).toHaveCount(0);
  });
}

for (const view of ["ai", "games"] as const) {
  test(`switching from pending Recording to ${view} ignores the old frame failure`, async ({
    page,
  }) => {
    await installReviewFixture(page);
    await page.clock.install();
    await page.addInitScript(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      let fail: (reason: Error) => void = () => {};
      const pending = new Promise<void>((_resolve, reject) => {
        fail = reject;
      });
      Object.assign(window, {
        failOldFrame: () => {
          fail(new Error("Old recording frame failed"));
        },
      });
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (
          request.path === "/api/gameplay/sessions/s0/frames" &&
          request.query.background_page !== "1"
        )
          await pending;
        const response = (await previous(request)) as { body: unknown };
        if (request.path === "/api/gameplay/sessions/s0" && request.query.background_page === "1") {
          const body = response.body as { items: Record<string, unknown>[]; total: number };
          body.items = Array.from({ length: 50 }, (_, i) => ({
            ...body.items[0],
            hand_id: String(842601 + i),
          }));
          body.total = body.items.length;
        }
        return response;
      };
    });
    await page.goto("/gameplay");
    const preview = page.getByRole("status", { name: "Recording preview loading" });
    await expect(preview).toBeVisible();
    const previewBox = (await preview.boundingBox())!,
      label = (await preview.getByText("Loading frame", { exact: true }).boundingBox())!;
    expect(label.y).toBeGreaterThanOrEqual(previewBox.y);
    expect(label.y + label.height).toBeLessThanOrEqual(previewBox.y + previewBox.height);
    await page.clock.fastForward(11000);
    await expect(
      page.getByText("Loading the first view timed out. Retry the recordings list."),
    ).toBeVisible();
    await page.getByRole("radio", { name: view === "ai" ? "AI view" : "Games view" }).click();
    const list = page.getByRole("list", {
      name: view === "ai" ? "OCR review crops" : "Recorded games",
    });
    await expect(list.getByRole("listitem").first()).toBeVisible();
    await expect(
      page.getByText("Loading the first view timed out. Retry the recordings list."),
    ).toHaveCount(0);
    if (view === "ai")
      await page.getByRole("textbox", { name: "Correct reading" }).fill("G 777.7 BB");
    await list.evaluate((element) => {
      element.scrollTop = 120;
    });
    const top = await list.evaluate((element) => element.scrollTop);
    expect(top).toBe(120);
    await page.evaluate(() => {
      (window as unknown as { failOldFrame: () => void }).failOldFrame();
    });
    await page.clock.fastForward(11000);
    await expect(
      page.getByText(/Old recording frame failed|Loading the first view timed out/),
    ).toHaveCount(0);
    expect(await list.evaluate((element) => element.scrollTop)).toBe(top);
    if (view === "ai")
      await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveValue(
        "G 777.7 BB",
      );
  });
}

test("focused queue discovers persisted readings without paid work and saves reviewed corrections", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  await expect(page.getByLabel("AI review", { exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Verification progress" })).toHaveAttribute(
    "value",
    "238",
  );
  await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveValue("G 355.6 BB");
  expect(
    await page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts),
  ).toEqual([]);
  expect(await page.locator(".gameplay-ai-crop-row").count()).toBeLessThan(30);
  await page.getByRole("button", { name: "View frame context" }).hover();
  await expect(page.getByRole("tooltip")).toHaveText("View frame context");
  await page.getByRole("button", { name: "View frame context" }).click();
  await expect(page.locator(".gameplay-ai-frame-context")).toBeVisible();
  await page.getByRole("textbox", { name: "Correct reading" }).fill("G 355.6 BB");
  await page.getByRole("button", { name: "Save and next" }).click();
  await expect(page.getByRole("status").filter({ hasText: "8 occurrences updated" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveValue("milkyway");
  const posted = await page.evaluate(
    () => (window as unknown as { reviewPosts: { body: unknown }[] }).reviewPosts,
  );
  expect(posted[0]?.body).toEqual({
    occurrence_id: "o0",
    expected_revision: 0,
    label: "G 355.6 BB",
    action: "manual",
  });
  await page.screenshot({
    path: testInfo.outputPath("poker-gameplay-ai-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 420, height: 800 });
  await expect(page.getByRole("combobox", { name: "Gameplay collection" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath("poker-gameplay-ai-narrow.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("review revision conflicts retain the edit and original Recording controls", async ({
  page,
}) => {
  await installReviewFixture(page);
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  await page.getByRole("textbox", { name: "Correct reading" }).fill("G 356.6 BB");
  await page.evaluate(() => {
    (window as unknown as { rejectReview: boolean }).rejectReview = true;
  });
  await page.getByRole("button", { name: "Save and next" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Reading changed" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveValue("G 356.6 BB");
  await page.getByRole("button", { name: "Refresh review" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Reading changed" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveValue("G 356.6 BB");
  for (const view of ["Games view", "Frames view", "AI view"]) {
    await page.getByRole("radio", { name: view }).click();
    await expect(page.getByLabel("Gameplay recording controls")).toHaveCount(0);
    expect(
      await page
        .locator(".gameplay-workspace")
        .evaluate((element) => getComputedStyle(element).paddingBottom),
    ).toBe("24px");
  }
  await page.getByRole("radio", { name: "Recording view" }).click();
  await expect(page.getByLabel("Gameplay recording controls")).toBeVisible();
  await page.getByRole("button", { name: "Rename recording" }).click();
  await page.getByLabel("Recording name to rename").fill("Renamed recording");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("button", { name: "Recording session" })).toHaveText(
    "Renamed recording",
  );
});

test("suit correction uses glyph choices and keeps frame progress in frames", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page);
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      const response = (await previous(request)) as { body: unknown };
      if (request.path === "/api/gameplay/ai/items") {
        const body = response.body as { items: Record<string, unknown>[] };
        if (body.items[0])
          Object.assign(body.items[0], {
            category: "suit",
            region_id: "community_cards[1].suit",
            label: "",
            original_label: "",
            guide: null,
            crop_url:
              "data:image/svg+xml," +
              encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="65"><rect width="50" height="65" fill="white"/><text x="6" y="49" fill="black" font-size="50">♣</text></svg>',
              ),
          });
      }
      return response;
    };
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  await expect(page.getByRole("progressbar", { name: "Verification progress" })).toHaveAttribute(
    "value",
    "238",
  );
  await expect(page.getByRole("progressbar", { name: "Verification progress" })).toHaveAttribute(
    "max",
    "332",
  );
  await page.getByRole("button", { name: "Clubs (c)" }).click();
  await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveValue("c");
  await expect(page.getByRole("button", { name: "Clubs (c)" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("textbox", { name: "Correct reading" }).focus();
  await page.getByRole("button", { name: "Clubs (c)" }).focus();
  await expect(page.getByRole("tooltip")).toHaveText("Clubs (c)");
  expect(
    await page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts),
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("poker-gameplay-ai-suit.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 420, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath("poker-gameplay-ai-suit-narrow.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("backend work groups retain occurrences, protected decisions and drafts across refresh", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page);
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    Object.assign(window, { groupedRevision: 0, groupedReads: [] });
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      const response = (await previous(request)) as { body: unknown };
      const state = window as unknown as { groupedRevision: number; groupedReads: string[] };
      if (request.path === "/api/gameplay/ai/status") {
        const body = response.body as { job: { revision: number; group_counts: unknown } };
        body.job.revision = state.groupedRevision;
        body.job.group_counts = {
          total: 33,
          pending: 0,
          verified: 0,
          corrected: 0,
          manual: 0,
          needs_review: 33,
          ambiguous: 0,
          error: 0,
          frames_completed: 238,
          frames_total: 332,
        };
      }
      if (request.path === "/api/gameplay/ai/items") {
        state.groupedReads.push(JSON.stringify(request.query));
        const body = response.body as {
          items: Record<string, unknown>[];
          total: number;
          hasMore: boolean;
          nextCursor: string | null;
        };
        const base = body.items[0]!;
        const club = {
          ...base,
          id: state.groupedRevision ? "club-1" : "club-0",
          work_key: "suit:proven-club",
          occurrence_count: 6,
          representative_occurrence_id: state.groupedRevision ? "club-1" : "club-0",
          region_id: "community_cards[1].suit",
          category: "suit",
          original_label: "",
          label: "",
          proposed_text: "c",
          state: "flagged",
          revision: state.groupedRevision,
          guide: null,
          conflicting_labels: [],
          reason: "Independent reading is uncertain",
          crop_url:
            "data:image/svg+xml," +
            encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="65"><rect width="50" height="65" fill="white"/><text x="6" y="49" fill="black" font-size="50">♣</text></svg>',
            ),
        };
        const conflict = {
          ...club,
          id: "human-0",
          work_key: "suit:human-conflict",
          region_id: "community_cards[2].suit",
          occurrence_count: 2,
          conflicting_labels: ["c", "s"],
          proposed_text: null,
          state: "conflict",
          reason: "Occurrence-owned human decisions differ",
        };
        const independent = {
          ...club,
          id: "different",
          work_key: "suit:different-pixels",
          region_id: "community_cards[3].suit",
          occurrence_count: 1,
        };
        const groups = [
          club,
          conflict,
          independent,
          ...Array.from({ length: 30 }, (_, i) => ({
            ...base,
            id: `other-${i}`,
            work_key: `name:${i}`,
            occurrence_count: 1,
            region_id: "seat.1.name",
            category: "name",
            label: `player ${i}`,
            state: "flagged",
          })),
        ];
        const occurrences =
          request.query.work_key === "suit:human-conflict"
            ? ["c", "s"].map((label, i) => ({
                ...conflict,
                id: `human-${i}`,
                frame_id: `human-frame-${i}`,
                label,
                state: "manual",
                has_manual_decision: true,
              }))
            : Array.from({ length: 6 }, (_, i) => ({
                ...club,
                id: `club-${i}`,
                frame_id: `club-frame-${i}`,
              }));
        const values = request.query.grouped === "false" ? occurrences : groups;
        const offset = Number(request.query.cursor || 0),
          end = Math.min(values.length, offset + Number(request.query.limit));
        Object.assign(body, {
          items: values.slice(offset, end),
          total: values.length,
          hasMore: end < values.length,
          nextCursor: end < values.length ? String(end) : null,
        });
      }
      return response;
    };
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  await expect(page.getByRole("button", { name: "Needs review 33 groups" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Review community_cards\[1\].suit/ })).toHaveCount(
    1,
  );
  await expect(page.getByLabel("6 occurrences", { exact: true })).toBeVisible();
  await expect(page.getByText("AI proposal · unverified")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveValue("c");
  await page.getByRole("textbox", { name: "Correct reading" }).fill("h");
  const queue = page.getByRole("list", { name: "OCR review crops" });
  await queue.evaluate((element) => {
    element.scrollTop = 120;
  });
  await page.evaluate(() => {
    (window as unknown as { groupedRevision: number }).groupedRevision++;
  });
  await expect(page.getByRole("button", { name: "Reload changed reading" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveValue("h");
  expect(await queue.evaluate((element) => element.scrollTop)).toBe(120);
  await page.getByRole("button", { name: "Reload changed reading" }).click();
  await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveValue("c");
  await queue.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.getByRole("button", { name: /Review community_cards\[2\].suit/ }).click();
  await page.getByText("2 occurrences", { exact: true }).click();
  const history = page.getByRole("list", { name: "Evidence occurrences" });
  await expect(history.getByRole("button")).toHaveCount(2);
  await history.getByRole("button").nth(1).click();
  await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveValue("s");
  await expect(history.getByRole("button").nth(0)).toContainText("c");
  await expect(history.getByRole("button").nth(1)).toContainText("s");
  await expect(page.getByText("Reviewed reading", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as unknown as { groupedReads: string[] }).groupedReads.some(
        (query) => query.includes('"grouped":"false"') && query.includes("suit:human-conflict"),
      ),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts),
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("poker-gameplay-ai-grouped.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 420, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath("poker-gameplay-ai-grouped-narrow.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("reviewed blank suits override captured colors in the frame preview", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page);
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      const response = (await previous(request)) as { body: unknown };
      if (
        request.path === "/api/gameplay/sessions/s0/frames" ||
        request.path.startsWith("/api/gameplay/frames/")
      ) {
        const body = response.body as {
          frames?: Record<string, unknown>[];
          frame?: Record<string, unknown>;
        };
        for (const frame of body.frames || (body.frame ? [body.frame] : [])) {
          const reading = (text: string) => ({
            prediction: { text, schema_valid: true, review_state: "manual" },
            rect: { x: 1, y: 1, w: 2, h: 2 },
            error: null,
          });
          frame.effective_results = {
            "community_cards[0]": reading("A"),
            "community_cards[0].suit": reading(""),
            "seats[0].cards[0]": reading("K"),
            "seats[0].cards[0].suit": reading(""),
            "community_cards[1]": reading("Q"),
          };
          frame.color_state = {
            seats: { "0": { in_play: true, hand_suits: ["h", null] } },
            community_suits: ["h", "d"],
            configuration: "recorded",
          };
        }
      }
      return response;
    };
  });
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "Frames view" }).click();
  await page
    .getByRole("button", { name: /Inspect frame/ })
    .first()
    .click();
  await expect(page.getByLabel("Community card 1: A", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Seat 1 card 1: K", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Community card 2: Q♦", { exact: true })).toBeVisible();
  await expect(page.locator('.poker-suit-symbol[data-suit="h"]')).toHaveCount(0);
  await page.locator(".suspected-game-state").screenshot({
    path: testInfo.outputPath("reviewed-blank-suits.png"),
  });
});

test("all card and picker heart presentations use the filled text heart", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page);
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      const response = (await previous(request)) as { body: unknown };
      if (
        request.path === "/api/gameplay/sessions/s0/frames" ||
        request.path.startsWith("/api/gameplay/frames/")
      ) {
        const body = response.body as {
          frames?: Record<string, unknown>[];
          frame?: Record<string, unknown>;
        };
        for (const frame of body.frames || (body.frame ? [body.frame] : [])) {
          const reading = (text: string) => ({
            prediction: { text, schema_valid: true },
            rect: { x: 1, y: 1, w: 2, h: 2 },
            error: null,
          });
          frame.config_snapshot = { regions: { seats: [{}] } };
          frame.results = { "community_cards[0]": reading("A"), "seats[0].cards[0]": reading("K") };
          frame.color_state = {
            seats: { "0": { in_play: true, hand_suits: ["h", null] } },
            community_suits: ["h"],
            configuration: "recorded",
          };
        }
      }
      if (request.path === "/api/gameplay/ai/items") {
        const body = response.body as { items: Record<string, unknown>[] };
        Object.assign(body.items[0]!, {
          category: "suit",
          region_id: "community_cards[0].suit",
          label: "h",
        });
      }
      return response;
    };
  });
  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.goto("/gameplay");
  await expect(page.getByLabel("Community card 1: A♥")).toBeVisible();
  await expect(page.getByLabel("Seat 1 card 1: K♥")).toBeVisible();
  const hearts = page.locator('.poker-suit-symbol[data-suit="h"]');
  await expect(hearts).toHaveCount(2);
  for (const heart of await hearts.all()) {
    await expect(heart).toHaveText("♥︎");
    await expect(heart).toHaveCSS("font-family", '"DejaVu Sans", serif');
  }
  await page
    .locator(".suspected-game-state")
    .screenshot({ path: testInfo.outputPath("poker-card-hearts-filled.png") });
  await page.getByRole("radio", { name: "AI view" }).click();
  const picker = page.getByRole("button", { name: "Hearts (h)" });
  await expect(picker).toHaveText("♥︎");
  await expect(picker.locator("span")).toHaveCSS("font-family", '"DejaVu Sans", serif');
  await page
    .locator(".gameplay-ai-suits")
    .screenshot({ path: testInfo.outputPath("poker-picker-hearts-filled.png") });
});

test("ambiguous evidence without crop assets keeps source context without broken media requests", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page);
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      const response = (await previous(request)) as { body: unknown };
      if (request.path === "/api/gameplay/ai/status") {
        const body = response.body as { job: { group_counts: { ambiguous: number } } };
        body.job.group_counts.ambiguous = 3;
      }
      if (request.path === "/api/gameplay/ai/items" && request.query.filter === "ambiguous") {
        const body = response.body as Record<string, unknown>;
        Object.assign(body, {
          items: Array.from({ length: 3 }, (_, i) => ({
            id: `unsupported-${i}`,
            work_key: `unsupported:bet-${i}`,
            representative_occurrence_id: `unsupported-${i}`,
            occurrence_count: 1,
            conflicting_labels: [],
            frame_id: `frame-${i}`,
            region_id: "seats[5].bet",
            category: "bet",
            label: "",
            original_label: "",
            state: "ambiguous",
            reason: "Panel is missing, merged, clipped, or ambiguous",
            crop_available: false,
            crop_url: null,
            image_url: "/api/mock-ambiguous-frame.svg",
            cache_kind: "unsupported",
            guide: null,
            revision: 0,
          })),
          total: 3,
          hasMore: false,
          nextCursor: null,
        });
      }
      return response;
    };
  });
  const cropRequests: string[] = [];
  await page.route("**/api/gameplay/ai/crop/**", async (route) => {
    cropRequests.push(route.request().url());
    await route.fulfill({ status: 404, body: "Unknown Gameplay crop" });
  });
  await page.route("**/api/mock-ambiguous-frame.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#143a2f"/><text x="850" y="500" fill="white" font-size="40">Source frame</text></svg>',
    }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  await page.getByRole("button", { name: "Ambiguous 3 groups" }).click();
  await expect(page.locator(".gameplay-ai-crop-row")).toHaveCount(3);
  await expect(page.locator(".gameplay-ai-thumbnail-unavailable")).toHaveCount(3);
  await expect(page.getByText("Crop unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("Panel is missing, merged, clipped, or ambiguous")).toBeVisible();
  await expect(
    page.locator(".gameplay-ai-crop-row img, .gameplay-ai-crop img, .gameplay-ai-crop image"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "View frame context" }).click();
  await expect(page.locator(".gameplay-ai-frame-context")).toHaveJSProperty("naturalWidth", 1920);
  await expect(page.getByRole("button", { name: "Ambiguous 3 groups" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(cropRequests).toEqual([]);
  expect(
    await page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts),
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("poker-gameplay-ai-unavailable-context.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("Benchmark archive browses without starting legacy controllers or posting changes", async ({
  page,
}) => {
  await page.addInitScript(installLabFixture);
  const posts: string[] = [];
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    Object.assign(window, { archivePosts: [] });
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      if (request.method !== "GET")
        (window as unknown as { archivePosts: string[] }).archivePosts.push(request.path);
      return previous(request);
    };
  });
  await page.goto("/collection");
  await expect(page.getByLabel("Archived OCR Benchmark", { exact: true })).toBeVisible();
  await expect(page.getByText("Archived · Read-only")).toBeVisible();
  await expect(page.getByRole("link", { name: "OCR Benchmark" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Capture|Record|Start review|Save label/ }),
  ).toHaveCount(0);
  expect(await page.locator('script[src$="/app.js"]').count()).toBe(0);
  posts.push(
    ...(await page.evaluate(() => (window as unknown as { archivePosts: string[] }).archivePosts)),
  );
  expect(posts).toEqual([]);
});

test("archive pages and virtualizes original crops with dataset-scoped images", async ({
  page,
}) => {
  await page.addInitScript(installLabFixture);
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    const reads: string[] = [];
    Object.assign(window, { archiveReads: reads, archiveWrites: [] });
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      if (request.method !== "GET")
        (window as unknown as { archiveWrites: string[] }).archiveWrites.push(request.path);
      if (request.path === "/api/db_entries") {
        const dataset = request.headers["x-dataset-id"];
        const offset = Number(request.query.cursor || 0),
          limit = Number(request.query.limit || 250);
        reads.push(`${dataset}:${offset}`);
        const total = dataset === "archived" ? 10 : 750;
        const end = Math.min(total, offset + limit);
        return {
          status: 200,
          headers: {},
          body: {
            items: Array.from({ length: end - offset }, (_, i) => ({
              id: `${dataset}-${offset + i}`,
              filename: `${dataset}-${offset + i}.png`,
              region_id: "seat.0.name",
              label: `${dataset} player ${offset + i}`,
            })),
            nextCursor: end < total ? String(end) : null,
            hasMore: end < total,
            total,
            meta: {},
          },
        };
      }
      return previous(request);
    };
  });
  await page.route("**/api/db_image/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><text y="30">player</text></svg>',
    }),
  );
  await page.goto("/collection");
  await expect(page.getByText("fixture player 0", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { archiveReads: string[] }).archiveReads.length),
    )
    .toBe(3);
  expect(await page.locator(".benchmark-archive-crop").count()).toBeLessThan(50);
  const image = page.locator(".benchmark-archive-crop img").first();
  await expect(image).toHaveJSProperty("naturalWidth", 100);
  await expect(image).toHaveAttribute("src", /dataset_id=fixture/);
  await page.getByRole("combobox", { name: "Archived benchmark dataset" }).selectOption("archived");
  await expect(page.getByText("archived player 0", { exact: true })).toBeVisible();
  await expect(page.locator(".benchmark-archive-crop img").first()).toHaveAttribute(
    "src",
    /dataset_id=archived/,
  );
  expect(
    await page.evaluate(() => (window as unknown as { archiveWrites: string[] }).archiveWrites),
  ).toEqual([]);
});

test("recording selection has no separate collection dropdown", async ({ page }) => {
  await page.addInitScript(installLabFixture);
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      const ok = (body: unknown) => ({ status: 200, headers: {}, body });
      if (request.path === "/api/gameplay/collections")
        return ok({
          default_collection_id: "current",
          collections: ["current", "other"].map((id) => ({
            id,
            name: id === "current" ? "Current games" : "Other collection",
            kind: "recordings",
            archived: false,
            recording_count: 1,
            frame_count: 1,
          })),
        });
      if (request.path === "/api/gameplay")
        return ok({
          sessions: [
            {
              id: request.query.collection_id || "current",
              name:
                request.query.collection_id === "other" ? "Other recording" : "Current recording",
              source: "TEST-1",
              interval_ms: 1000,
              status: "stopped",
              created_at: "2026-11-13T00:00:00Z",
              frame_count: 0,
              hand_count: 0,
            },
          ],
        });
      if (request.path.startsWith("/api/gameplay/sessions/"))
        return ok(request.path.endsWith("/frames") ? { frames: [] } : { hands: [] });
      return previous(request);
    };
  });
  await page.goto("/gameplay");
  await expect(page.getByRole("button", { name: "Recording session" })).toHaveText(
    "Current recording",
  );
  await expect(page.getByRole("combobox", { name: "Gameplay collection" })).toHaveCount(0);
});

test("exhausted review keeps its job and drafts until an explicit larger limit is resumed", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page, "failed");
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    const budget = { limit: 175, requests: 175, providerCalls: 0 };
    Object.assign(window, { reviewBudget: budget });
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      if (request.path === "/api/gameplay/ai/prepare")
        throw new Error("Resume must keep the existing job");
      if (request.path === "/api/gameplay/ai/resume") {
        const body = request.body as { job_id: string; max_requests: number };
        if (body.job_id !== "j0" || body.max_requests <= budget.requests)
          throw new Error("Exhausted review must receive an explicit larger cumulative limit");
        budget.limit = body.max_requests;
        budget.providerCalls++;
      }
      const response = (await previous(request)) as { body: unknown };
      if (request.path === "/api/gameplay/ai/status") {
        const body = response.body as { job: Record<string, unknown> };
        Object.assign(body.job, { max_requests: budget.limit });
        (body.job.usage as { requests: number }).requests = budget.requests;
        if (body.job.state === "failed")
          body.job.error = "Gameplay request budget reached; no further API request was sent";
      }
      return response;
    };
  });
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  await page.getByText("Review details", { exact: true }).click();
  const limit = page.getByRole("spinbutton", { name: "Request limit" });
  await expect(limit).toHaveValue("175");
  await expect(page.getByRole("region", { name: "Review queue" })).toHaveCount(0);
  await page.getByRole("button", { name: "Resume review" }).click();
  await expect(page.getByRole("alert")).toHaveText("Increase the request limit before resuming.");
  await limit.fill("240");
  await page.getByRole("button", { name: "Auto-correction enabled" }).click();
  await page.getByRole("radio", { name: "Frames view" }).click();
  await page.getByRole("radio", { name: "AI view" }).click();
  await page.getByText("Review details", { exact: true }).click();
  await expect(limit).toHaveValue("240");
  await expect(page.getByRole("button", { name: "Auto-correction disabled" })).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { reviewBudget: { providerCalls: number } }).reviewBudget
          .providerCalls,
    ),
  ).toBe(0);
  await page.screenshot({
    path: testInfo.outputPath("poker-request-limit-exhausted.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Resume review" }).click();
  await expect(limit).toBeDisabled();
  expect(
    await page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts),
  ).toEqual([
    {
      path: "/api/gameplay/ai/resume",
      body: { job_id: "j0", max_requests: 240 },
    },
  ]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { reviewBudget: { providerCalls: number } }).reviewBudget
          .providerCalls,
    ),
  ).toBe(1);
  await expect(page.getByRole("region", { name: "Review queue" })).toHaveCount(0);
  await page.evaluate(() => {
    (window as unknown as { reviewControl: { state: string } }).reviewControl.state = "completed";
  });
  await expect(page.getByRole("region", { name: "Review queue" })).toBeVisible();
  await expect(limit).toHaveValue("240");
  await expect(limit).toBeEnabled();
  await page.setViewportSize({ width: 420, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath("poker-request-limit-completed-narrow.png"),
    fullPage: true,
  });
});

test("legacy verified readings show their original source crop while new regions stay pending", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page);
  const sourceCrop =
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="50"><rect width="480" height="50" fill="#153c34"/><text x="12" y="33" fill="white" font-family="monospace" font-size="23">355.6 BB</text></svg>';
  const cropPath = "/api/gameplay/ai/crop/legacy-original-fixture";
  await page.route(`**${cropPath}`, (route) =>
    route.fulfill({ status: 200, contentType: "image/svg+xml", body: sourceCrop }),
  );
  await page.addInitScript((cropPath) => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      const response = await previous(
        request.path === "/api/gameplay/ai/items"
          ? { ...request, query: { ...request.query, filter: "all" } }
          : request,
      );
      const body = (response as { body: Record<string, unknown> }).body;
      if (request.path === "/api/gameplay/ai/status") {
        const job = body.job as Record<string, unknown>;
        job.group_counts = {
          total: 2,
          pending: 1,
          verified: 1,
          corrected: 0,
          manual: 0,
          needs_review: 0,
          ambiguous: 0,
          error: 0,
          frames_completed: 0,
          frames_total: 1,
        };
        job.counts = job.group_counts;
      }
      if (request.path === "/api/gameplay/ai/items") {
        const original = (body.items as Record<string, unknown>[])[0]!;
        const legacy = {
          ...original,
          id: "legacy-original",
          work_key: "legacy-original",
          region_id: "seat.4.bet",
          label: "355.6 BB",
          original_label: "355.6 BB",
          state: "legacy_verified",
          source: "legacy",
          crop_scope: "legacy_source",
          crop_url: cropPath,
          guide: null,
          cache_kind: "legacy",
          legacy_provenance: {
            policy: "occurrence_owned_legacy_annotations_v2",
            source_dataset: "fixture",
            source_database: "/fixture/data.db",
            source_database_receipt: { "data.db": "digest" },
            source_region_id: "seat.4.bet",
            target_region_id: "seat.4.bet",
            target_profile_id: "profile",
            target_profile_sha256: "profile-digest",
            source_config_digest: "original-config",
            original_rect: { x: 0, y: 0, w: 480, h: 50 },
            original_pixel_sha256: "pixels",
            original_image_sha256: "svg",
            label_present: true,
            explicit_blank: false,
            pixel_relationship: "original fixture source crop",
            visually_verified: false,
            capture: { id: 1 },
            crop: { id: 2, label: "355.6 BB" },
          },
        };
        const pending = {
          ...original,
          id: "new-suit",
          work_key: "new-suit",
          region_id: "seat.4.card1.suit",
          label: "",
          original_label: "",
          state: "pending",
          source: "none",
          guide: null,
        };
        const filter = request.query.filter;
        body.items =
          filter === "completed"
            ? [legacy]
            : filter === "pending"
              ? [pending]
              : filter === "all"
                ? [legacy, pending]
                : [];
        body.total = (body.items as unknown[]).length;
        body.hasMore = false;
        body.nextCursor = null;
      }
      return response;
    };
  }, cropPath);
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  const imageResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === cropPath,
  );
  await page.getByRole("button", { name: "Verified 1 groups", exact: true }).click();
  await expect(page.getByText("Original legacy crop", { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Crop inspector" })
      .getByText("Verified · Legacy", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveValue("355.6 BB");
  const response = await imageResponse;
  expect(response.status()).toBe(200);
  expect(await response.text()).toBe(sourceCrop);
  const image = page.getByRole("img", { name: "seat.4.bet crop", exact: true });
  await expect(image).toHaveAttribute("src", cropPath);
  await expect
    .poll(() =>
      image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth === 480),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("poker-legacy-original-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 420, height: 800 });
  await expect(page.getByText("Original legacy crop", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("poker-legacy-original-narrow-list.png"),
    fullPage: true,
  });
  await image.scrollIntoViewIfNeeded();
  const heading = page.locator(".gameplay-ai-inspector-heading > strong");
  await expect(heading).toHaveText("seat.4.bet");
  const headingLayout = await heading.evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    lineHeight: parseFloat(getComputedStyle(node).lineHeight),
  }));
  expect(headingLayout.height).toBeLessThanOrEqual(headingLayout.lineHeight + 1);
  await page.screenshot({
    path: testInfo.outputPath("poker-legacy-original-narrow.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Pending 1 groups", exact: true }).click();
  await expect(page.getByText("Original legacy crop", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Crop inspector" }).getByText("Pending", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveValue("");
  expect(
    await page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts),
  ).toEqual([]);
});

test("paused review applies a lower explicit limit to the same job on Resume", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page, "cancelled");
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    let limit = 10000;
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      if (request.path === "/api/gameplay/ai/prepare")
        throw new Error("Resume must preserve the frozen job");
      if (request.path === "/api/gameplay/ai/resume") {
        const body = request.body as { job_id: string; max_requests: number };
        if (body.job_id !== "j0" || body.max_requests !== 650)
          throw new Error("Resume ignored the displayed limit");
        limit = body.max_requests;
      }
      const response = (await previous(request)) as {
        body: { job?: { max_requests: number; usage: { requests: number } } };
      };
      if (response.body.job) {
        response.body.job.max_requests = limit;
        response.body.job.usage.requests = 65;
      }
      return response;
    };
  });
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  await page.getByText("Review details", { exact: true }).click();
  const limit = page.getByRole("spinbutton", { name: "Request limit" });
  await expect(limit).toHaveValue("10000");
  await limit.fill("650");
  await page.getByRole("button", { name: "Resume review" }).click();
  await expect(page.getByRole("button", { name: "Pause review" })).toBeVisible();
  await expect(limit).toHaveValue("650");
  expect(
    await page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts),
  ).toEqual([{ path: "/api/gameplay/ai/resume", body: { job_id: "j0", max_requests: 650 } }]);
  await page.screenshot({ path: testInfo.outputPath("paused-budget-650.png"), fullPage: true });
});

test("Refresh recovers locked status to completed progress and queue using only GET", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page, "running");
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    const recovery = { reads: 0, locked: true };
    Object.assign(window, { statusRecovery: recovery });
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      if (request.path !== "/api/gameplay/ai/status") return previous(request);
      recovery.reads++;
      if (recovery.reads > 1 && recovery.locked)
        return { status: 503, headers: {}, body: { error: "database is locked" } };
      const response = (await previous(request)) as {
        body: {
          job: {
            state: string;
            counts: { total: number; frames_completed: number };
            scope: { unique_crops: number };
            group_counts: { total: number; frames_completed: number };
            usage: { requests: number };
          };
        };
      };
      const job = response.body.job;
      job.state = recovery.locked ? "running" : "completed";
      job.counts.total = recovery.locked ? 800 : 1974;
      job.scope.unique_crops = recovery.locked ? 223 : 1974;
      job.counts.frames_completed = recovery.locked ? 100 : 332;
      job.group_counts.total = recovery.locked ? 223 : 350;
      job.usage.requests = recovery.locked ? 200 : 532;
      return response;
    };
  });
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  await page.getByText("Review details", { exact: true }).click();
  await expect(page.getByText(/200 requests/)).toBeVisible();
  await expect(page.getByText("0 / 223 unique crops", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Review queue" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveText("database is locked");
  await page.screenshot({ path: testInfo.outputPath("status-locked.png"), fullPage: true });
  await page.evaluate(() => {
    (window as unknown as { statusRecovery: { locked: boolean } }).statusRecovery.locked = false;
  });
  await page.getByRole("button", { name: "Refresh review" }).click();
  await expect(page.getByText("AI complete", { exact: true })).toBeVisible();
  await expect(page.getByText(/532 requests/)).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Verification progress" })).toHaveAttribute(
    "max",
    "332",
  );
  await expect(page.getByRole("progressbar", { name: "Verification progress" })).toHaveAttribute(
    "value",
    "332",
  );
  await expect(page.getByText(/1,974 unique crops/)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Review queue" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Needs review 350 groups" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveValue("G 355.6 BB");
  expect(
    await page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts),
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("status-recovered.png"), fullPage: true });
  await page.setViewportSize({ width: 420, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("status-recovered-narrow.png"),
    fullPage: true,
  });
});

test("completed approval preserves queue, focus and scroll through a delayed save without offering paid work", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page);
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let releaseReads = () => {};
    let committed = false;
    const reads = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    Object.assign(window, { releaseManualSave: release, releaseBackgroundReads: releaseReads });
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      if (request.path === "/api/gameplay/ai/review") {
        await gate;
        const response = await previous(request);
        committed = true;
        return response;
      }
      if (request.path === "/api/gameplay/ai/status" && committed) await reads;
      return previous(request);
    };
  });
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  await expect(page.getByText("350 groups remaining", { exact: true })).toBeVisible();
  const paid = page.getByRole("button", { name: /Start review|Resume review|Process new frames/ });
  await expect(paid).toHaveCount(0);
  const queue = page.getByRole("list", { name: "OCR review crops" });
  const selected = page.getByRole("button", { name: "Review seat.4.bet in frame f4", exact: true });
  await selected.click();
  await queue.evaluate((node) => {
    node.scrollTop = 120;
  });
  const top = await queue.evaluate((node) => node.scrollTop);
  await page.getByRole("textbox", { name: "Correct reading" }).fill("G 355.6 BB");
  await page.evaluate(() => {
    const observations: string[] = [];
    const observer = new MutationObserver(() => {
      observations.push(document.querySelector(".gameplay-ai-counts")?.textContent ?? "missing");
    });
    observer.observe(document.querySelector(".gameplay-ai")!, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    Object.assign(window, { manualCountObservations: observations });
  });
  await page.getByRole("button", { name: "Save and next" }).click();
  await expect(page.getByRole("button", { name: "Save and next" })).toBeDisabled();
  await expect(page.getByText("AI complete", { exact: true })).toBeVisible();
  await expect(page.getByText("350 groups remaining", { exact: true })).toBeVisible();
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveValue("G 355.6 BB");
  expect(await queue.evaluate((node) => node.scrollTop)).toBe(top);
  await page.screenshot({
    path: testInfo.outputPath("completed-save-pending-desktop.png"),
    fullPage: true,
  });
  await page.evaluate(() => {
    (window as unknown as { releaseManualSave: () => void }).releaseManualSave();
  });
  await expect(page.getByText("350 groups remaining", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save and next" })).toBeEnabled();
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Review seat.2.name in frame f5", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Correct reading" })).toHaveValue("milkyway");
  expect(await queue.evaluate((node) => node.scrollTop)).toBe(top);
  expect(
    await page.evaluate(() =>
      (window as unknown as { manualCountObservations: string[] }).manualCountObservations.every(
        (value) => /^(350|349) groups remaining$/.test(value),
      ),
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("completed-save-get-pending-desktop.png"),
    fullPage: true,
  });
  await page.evaluate(() => {
    (window as unknown as { releaseBackgroundReads: () => void }).releaseBackgroundReads();
  });
  await expect(page.getByText("349 groups remaining", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review seat.2.name in frame f5", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Refresh review" }).click();
  await page.getByRole("radio", { name: "Frames view" }).click();
  await page.getByRole("radio", { name: "AI view" }).click();
  await expect(page.getByText("AI complete", { exact: true })).toBeVisible();
  await expect(paid).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as unknown as { reviewPosts: { path: string }[] }).reviewPosts.map(
        (post) => post.path,
      ),
    ),
  ).toEqual(["/api/gameplay/ai/review"]);
  await page.setViewportSize({ width: 420, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("completed-save-narrow.png"), fullPage: true });
  await page.getByRole("region", { name: "Crop inspector" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Save and next" })).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("completed-save-inspector-narrow.png"),
    fullPage: true,
  });
});

test("completed zero groups remains read-only through refresh and remount", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page);
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      const response = (await previous(request)) as {
        body: {
          job?: { group_counts: Record<string, number> };
          items?: unknown[];
          total?: number;
          nextCursor?: string | null;
          hasMore?: boolean;
        };
      };
      if (request.path === "/api/gameplay/ai/status" && response.body.job) {
        Object.assign(response.body.job.group_counts, { needs_review: 0, manual: 350 });
      }
      if (request.path === "/api/gameplay/ai/items")
        Object.assign(response.body, { items: [], total: 0, nextCursor: null, hasMore: false });
      return response;
    };
  });
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  await expect(page.getByText("0 groups remaining", { exact: true })).toBeVisible();
  await expect(page.getByText("No crops", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh review" }).click();
  await page.getByRole("radio", { name: "Frames view" }).click();
  await page.getByRole("radio", { name: "AI view" }).click();
  await expect(page.getByText("0 groups remaining", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Start review|Resume review|Process new frames/ }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { reviewPosts: unknown[] }).reviewPosts),
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("completed-zero-desktop.png"),
    fullPage: true,
  });
});

test("six acknowledged occurrences do not fabricate a grouped count transition on refresh or remount", async ({
  page,
}, testInfo) => {
  await installReviewFixture(page);
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    let representative: Record<string, unknown> | undefined;
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      if (request.path === "/api/gameplay/ai/review") {
        const body = request.body as { label: string };
        return {
          status: 200,
          headers: {},
          body: {
            item: {
              ...representative,
              state: "manual",
              label: body.label,
              revision: 1,
              has_manual_decision: true,
            },
            revision: 1,
            affected_count: 6,
          },
        };
      }
      const response = (await previous(request)) as {
        status: number;
        headers: Record<string, string>;
        body: { items: Record<string, unknown>[] };
      };
      if (request.path === "/api/gameplay/ai/items") {
        const body = response.body;
        representative ??= body.items[0];
      }
      return response;
    };
  });
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "AI view" }).click();
  await expect(page.getByText("350 groups remaining", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const counts: string[] = [];
    const observer = new MutationObserver(() => {
      counts.push(document.querySelector(".gameplay-ai-counts")?.textContent ?? "missing");
    });
    observer.observe(document.querySelector(".gameplay-ai")!, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    Object.assign(window, { manualProjectionCounts: counts });
  });
  await page.getByRole("textbox", { name: "Correct reading" }).fill("G 22 BB");
  await page.getByRole("button", { name: "Save and next" }).click();
  await expect(page.getByText("6 occurrences updated", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save and next" })).toBeEnabled();
  await page.getByRole("button", { name: "Refresh review" }).click();
  await expect(page.getByText("350 groups remaining", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Verified 0 groups" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review seat.4.bet in frame f0", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(() =>
      (window as unknown as { manualProjectionCounts: string[] }).manualProjectionCounts.every(
        (value) => value === "350 groups remaining",
      ),
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("authoritative-unchanged-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("radio", { name: "Frames view" }).click();
  await page.getByRole("radio", { name: "AI view" }).click();
  await expect(page.getByText("350 groups remaining", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 420, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("authoritative-unchanged-narrow.png"),
    fullPage: true,
  });
});
