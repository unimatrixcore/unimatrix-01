import { expect, test } from "@playwright/test";
import type { PokerLabRequest } from "@unimatrix/shared";
import { installLabFixture } from "./fixture.js";

test("remembers the capture interval while stopped and ignores invalid saved values", async ({
  page,
}) => {
  await page.addInitScript(installLabFixture);
  await page.goto("/collection");
  await expect(page.locator("#loading-overlay")).toBeHidden();
  await page.evaluate(() => {
    localStorage.setItem("poker:capture-interval-seconds", "999");
  });
  await page.reload();
  await expect(page.locator("#watch-interval")).toHaveValue("2");
  await page
    .getByRole("button", { name: "Capture source and recording settings", exact: true })
    .click();
  await page.locator("#watch-interval").selectOption("5");
  await page.reload();
  await expect(page.locator("#watch-interval")).toHaveValue("5");
  await expect(page.locator("#watch-status")).toHaveAttribute("data-active", "false");
});

test("gameplay reload reconnects its recording and explicit Stop survives another reload", async ({
  page,
}) => {
  const session = {
    id: "continued-session",
    name: "Reload recording",
    source: "TEST-1",
    interval_ms: 1000,
    status: "ready",
    created_at: "2026-11-13T00:00:00Z",
    frame_count: 0,
    hand_count: 0,
  };
  let creates = 0;
  let captures = 0;
  let stops = 0;
  await page.exposeFunction("recordingBackend", (request: PokerLabRequest) => {
    let body: object;
    if (request.path === "/api/gameplay/sources") body = { sources: [{ name: "TEST-1" }] };
    else if (request.path === "/api/gameplay/sessions" && request.method === "POST") {
      creates++;
      body = { session };
    } else if (request.path.endsWith("/capture")) {
      captures++;
      body = { skipped: true, reason: "Fixture waiting" };
    } else if (request.path.endsWith("/stop")) {
      stops++;
      session.status = "stopped";
      body = { session };
    } else if (request.path.endsWith("/continued-session")) body = { session, hands: [] };
    else if (request.path.endsWith("/frames"))
      body = { frames: [], items: [], total: 0, hasMore: false, nextCursor: null, meta: null };
    else
      body = {
        sessions: creates ? [session] : [],
        items: creates ? [session] : [],
        total: creates ? 1 : 0,
        hasMore: false,
        nextCursor: null,
        meta: null,
      };
    return { status: 200, headers: { "content-type": "application/json" }, body };
  });
  await page.addInitScript(installLabFixture);
  await page.addInitScript(() => {
    const original = window.__POKER_LAB_TEST_INVOKE__;
    window.__POKER_LAB_TEST_INVOKE__ = (request) =>
      request.path.startsWith("/api/gameplay")
        ? (window as unknown as { recordingBackend: typeof original }).recordingBackend!(request)
        : original!(request);
  });
  await page.goto("/gameplay");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect.poll(() => captures).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  const before = captures;
  await page.reload();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect.poll(() => captures).toBeGreaterThan(before);
  expect(creates).toBe(1);
  expect(stops).toBe(0);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const paused = captures;
  await page.reload();
  await expect(page.getByRole("button", { name: "Record", exact: true })).toBeVisible();
  await page.waitForTimeout(1200);
  expect(captures).toBe(paused);
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect.poll(() => captures).toBeGreaterThan(paused);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => stops).toBe(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
  expect(stops).toBe(1);
  expect(creates).toBe(1);
});

test("collection reload retains its lease, source and interval, while navigation explicitly stops", async ({
  page,
}) => {
  const requests: PokerLabRequest[] = [];
  await page.exposeFunction("rememberRecordingRequest", (request: PokerLabRequest) => {
    requests.push(request);
  });
  await page.addInitScript(installLabFixture);
  await page.addInitScript(() => {
    const original = window.__POKER_LAB_TEST_INVOKE__;
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      if (request.path.startsWith("/api/watch/"))
        await (
          window as unknown as { rememberRecordingRequest: (request: unknown) => Promise<void> }
        ).rememberRecordingRequest(request);
      return original!(request);
    };
  });
  await page.goto("/collection");
  await expect(page.locator("#loading-overlay")).toBeHidden();
  await page
    .getByRole("button", { name: "Capture source and recording settings", exact: true })
    .click();
  await page.locator("#watch-interval").selectOption("2");
  await page.keyboard.press("Escape");
  await page.locator("#watch-start").click();
  await expect
    .poll(() => requests.filter((r) => r.path.endsWith("/tick")).length)
    .toBeGreaterThan(0);
  const before = requests.filter((r) => r.path.endsWith("/tick")).length;
  await page.reload();
  await expect
    .poll(() => requests.filter((r) => r.path.endsWith("/tick")).length)
    .toBeGreaterThan(before);
  expect(requests.filter((r) => r.path.endsWith("/start"))).toHaveLength(1);
  expect(requests.filter((r) => r.path.endsWith("/stop"))).toHaveLength(0);
  await expect(page.locator("#watch-interval")).toHaveValue("2");
  await page
    .getByRole("navigation", { name: "Sections", exact: true })
    .getByRole("link", { name: "Gameplay" })
    .click();
  await expect.poll(() => requests.filter((r) => r.path.endsWith("/stop")).length).toBe(1);
});
