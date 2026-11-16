import { expect, test } from "@playwright/test";
import { installLabFixture } from "./fixture.js";

for (const failure of [false, true]) {
  test(`recording shortcuts stay blocked during a ${failure ? "failed" : "successful"} workspace stop`, async ({
    page,
  }) => {
    await page.addInitScript({
      content: `(${installLabFixture.toString()})(); (${(() => {
        const previous = window.__POKER_LAB_TEST_INVOKE__!;
        const gate = { requested: false, release: false, failure: false, captures: 0 };
        Object.assign(window, { stopGate: gate });
        const session = {
          id: "paused",
          name: "Paused recording",
          source: "TEST-1",
          interval_ms: 1000,
          status: "paused",
          created_at: "2026-11-12T00:00:00Z",
          frame_count: 0,
          hand_count: 0,
        };
        const success = (body: unknown) => ({ status: 200, headers: {}, body });
        window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
          if (request.path === "/api/gameplay") {
            if (request.query.archived === "1") return success({ sessions: [] });
            return success({ sessions: [session] });
          }
          if (request.path === "/api/gameplay/sessions/paused/stop") {
            gate.requested = true;
            while (!gate.release) await new Promise((resolve) => setTimeout(resolve, 10));
            return gate.failure
              ? { status: 500, headers: {}, body: { error: "Stop failed" } }
              : success({ session: { ...session, status: "stopped" } });
          }
          if (request.path === "/api/gameplay/sessions/paused/capture") {
            gate.captures++;
            return success({ skipped: true, reason: "Fixture has no poker table" });
          }
          if (request.path === "/api/gameplay/sessions/paused/frames")
            return success({ frames: [] });
          if (request.path === "/api/gameplay/sessions/paused") return success({ hands: [] });
          return previous(request);
        };
      }).toString()})();`,
    });
    await page.goto("/gameplay");
    await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
    await page.evaluate((fail) => {
      (window as unknown as { stopGate: { failure: boolean } }).stopGate.failure = fail;
    }, failure);
    await expect(page.getByRole("button", { name: "Recording session", exact: true })).toHaveText(
      "Paused recording",
    );
    await expect(page.getByRole("button", { name: "Record", exact: true })).toBeEnabled();
    await page.evaluate(() => {
      history.replaceState({ view: "collection" }, "", "/collection");
      history.pushState({ pokerGameplay: true }, "", "/gameplay");
    });
    await page.goBack();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { stopGate: { requested: boolean } }).stopGate.requested,
        ),
      )
      .toBe(true);
    await expect(page.locator(".gameplay-workspace")).toBeVisible();
    await page.locator("#main-content").focus();
    await page.keyboard.press("w");
    await page.keyboard.press("c");
    await page.keyboard.press("Space");
    expect(
      await page.evaluate(
        () => (window as unknown as { stopGate: { captures: number } }).stopGate.captures,
      ),
    ).toBe(0);
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
    await page.evaluate(() => {
      (window as unknown as { stopGate: { release: boolean } }).stopGate.release = true;
    });
    if (failure) {
      await expect(page).toHaveURL(/\/gameplay$/);
      await expect(page.locator(".gameplay-error")).toHaveText(/Stop failed/);
      await expect(page.getByRole("button", { name: "Record", exact: true })).toBeEnabled();
      await page.locator("#main-content").focus();
      await page.keyboard.press("w");
      await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
      await page.keyboard.press("w");
      await expect(page.getByRole("button", { name: "Capture", exact: true })).toBeEnabled();
      await page.keyboard.press("c");
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { stopGate: { captures: number } }).stopGate.captures,
          ),
        )
        .toBe(2);
    } else {
      await expect(page.getByLabel("Archived OCR Benchmark", { exact: true })).toBeVisible();
      await page.goForward();
      await expect(page.locator(".gameplay-workspace")).toBeVisible();
      await expect(page.locator(".gameplay-recording-panel .recording-status")).toHaveText(
        "Stopped",
      );
      await expect(
        page.getByRole("button", { name: "Recording session", exact: true }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "New recording", exact: true }).click();
      await expect(page.getByRole("button", { name: "Capture", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Record", exact: true })).toBeEnabled();
    }
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`saved capture warning pauses recording at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript({
      content: `(${installLabFixture.toString()})(); (${(() => {
        const previous = window.__POKER_LAB_TEST_INVOKE__!;
        const state = { captures: 0 };
        Object.assign(window, { warningFixture: state });
        const session = {
          id: "saved",
          name: "Saved recording",
          source: "TEST-1",
          interval_ms: 1000,
          status: "paused",
          created_at: "2026-11-12T00:00:00Z",
          frame_count: 1,
          hand_count: 0,
        };
        const success = (body: unknown) => ({ status: 200, headers: {}, body });
        window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
          if (request.path === "/api/gameplay")
            return success({ sessions: request.query.archived === "1" ? [] : [session] });
          if (request.path === "/api/gameplay/sessions/saved/capture") {
            state.captures++;
            return success({
              session,
              frame: {
                id: "saved-frame",
                session_id: "saved",
                hand_id: null,
                captured_at: "2026-11-12T00:00:00Z",
                image_url:
                  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aZkAAAAASUVORK5CYII=",
                width: 1,
                height: 1,
                ocr_status: "partial",
                error: null,
                effective_region_error: "Fixture enrichment failure",
              },
            });
          }
          if (request.path === "/api/gameplay/sessions/saved/frames")
            return success({ frames: [] });
          if (request.path === "/api/gameplay/sessions/saved") return success({ hands: [] });
          return previous(request);
        };
      }).toString()})();`,
    });
    await page.goto("/gameplay");
    await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
    await expect(page.getByRole("button", { name: "Record", exact: true })).toBeEnabled();
    await page.clock.install();
    await page.getByRole("button", { name: "Record", exact: true }).click();
    await expect(page.locator(".gameplay-error")).toContainText(
      "Frame saved, but region details could not be loaded: Fixture enrichment failure",
    );
    await expect(page.getByRole("button", { name: "Record", exact: true })).toBeVisible();
    await page.clock.fastForward(5000);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { warningFixture: { captures: number } }).warningFixture.captures,
      ),
    ).toBe(1);
    await page.screenshot({ path: `/tmp/poker-capture-warning-${viewport.width}.png` });
  });
}
