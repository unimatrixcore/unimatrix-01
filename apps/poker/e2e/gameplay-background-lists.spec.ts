import { expect, test } from "@playwright/test";
import { installLabFixture } from "./fixture.js";

test("Gameplay pages eagerly, preserves its snapshot and manages catalogs", async ({ page }) => {
  await page.addInitScript(installLabFixture);
  await page.addInitScript(() => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    let release: (() => void) | undefined;
    (window as unknown as { gameplayCaptures: number }).gameplayCaptures = 0;
    const requests: string[] = [];
    (window as unknown as { gameplayRequests: string[] }).gameplayRequests = requests;
    (window as unknown as { gameplayHeld: boolean }).gameplayHeld = false;
    let name = "Session 0";
    let archived = false;
    (window as unknown as { releaseGameplay: () => void }).releaseGameplay = () => release?.();
    const session = (i: number) => ({
      id: `s${i}`,
      name: i === 0 ? name : `Session ${i}`,
      source: "TEST-1",
      interval_ms: 1000,
      status: "paused",
      created_at: "2026-11-12T00:00:00Z",
      frame_count: 1000,
      hand_count: 1000,
    });
    const frame = (i: number, id = "s0") => ({
      id: `f${i}-${id}`,
      session_id: id,
      hand_id: `h${i}`,
      captured_at: "2026-11-12T00:00:00Z",
      ocr_status: "complete",
      error: null,
      image_url:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='50'/%3E",
      width: 100,
      height: 50,
    });
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      const success = (body: unknown) => ({ status: 200, headers: {}, body });
      const path = request.path;
      if (path === "/api/gameplay/sources") return success({ sources: [{ name: "TEST-1" }] });
      if (path === "/api/gameplay/sessions/s0/rename") {
        name = String((request.body as { name: string }).name);
        return success({ session: session(0) });
      }
      if (path === "/api/gameplay/sessions/s0/archive") {
        archived = true;
        return success({ session: session(0) });
      }
      if (path === "/api/gameplay/sessions/s0/restore") {
        archived = false;
        return success({ session: session(0) });
      }
      if (path.endsWith("/capture")) {
        (window as unknown as { gameplayCaptures: number }).gameplayCaptures++;
        return success({ frame: frame(9999), session: session(0) });
      }
      if (path.startsWith("/api/gameplay/frames/"))
        return success({
          frame: frame(Number(path.split("/").at(-1)?.split("-")[0]?.slice(1)) || 0),
        });
      if (request.query.background_page === "1" && path.startsWith("/api/gameplay")) {
        const offset = Number(request.query.cursor || 0);
        requests.push(
          `${path}:${request.query.hand_id ?? request.query.archived ?? "all"}:${offset}`,
        );
        if (path.endsWith("/frames") && offset === 250 && !release)
          await new Promise<void>((resolve) => {
            release = resolve;
            (window as unknown as { gameplayHeld: boolean }).gameplayHeld = true;
          });
        let items: unknown[];
        let total = 1000;
        if (path === "/api/gameplay") {
          const isArchive = request.query.archived === "1";
          total = isArchive ? (archived ? 1000 : 0) : 1000;
          items = Array.from({ length: Math.min(250, total - offset) }, (_, j) =>
            session(isArchive ? offset + j : offset + j + (archived ? 1 : 0)),
          );
        } else if (path.endsWith("/frames")) {
          const id = path.split("/")[4]!;
          total = request.query.hand_id ? 1 : 1000;
          items = Array.from({ length: Math.max(0, Math.min(250, total - offset)) }, (_, j) =>
            frame(offset + j, id),
          );
        } else
          items = Array.from({ length: Math.min(250, total - offset) }, (_, j) => ({
            hand_id: `h${offset + j}`,
            frame_count: 1,
            first_at: "2026-11-12T00:00:00Z",
            last_at: "2026-11-12T00:00:00Z",
          }));
        return success({
          items,
          nextCursor: offset + 250 < total ? String(offset + 250) : null,
          hasMore: offset + 250 < total,
          total,
          meta: {},
        });
      }
      if (path.endsWith("/frames")) return success({ frames: [frame(0)], total: 1 });
      if (path === "/api/gameplay") return success({ sessions: [session(0)] });
      return previous(request);
    };
  });
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "Frames view" }).click();
  await expect(page.getByLabel("Recorded frames")).toBeVisible();
  await expect(page.getByRole("button", { name: /Inspect frame/ }).first()).toBeVisible();
  expect(await page.locator(".gameplay-frame-card").count()).toBeLessThan(100);
  const frameBox = await page.locator(".gameplay-frame-card").first().boundingBox();
  const frameListBox = await page.getByLabel("Recorded frames").boundingBox();
  expect(
    frameBox && frameListBox && frameBox.width <= frameListBox.width && frameBox.width >= 180,
  ).toBeTruthy();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { gameplayHeld: boolean }).gameplayHeld))
    .toBe(true);
  await page.evaluate(() => {
    (window as unknown as { releaseGameplay: () => void }).releaseGameplay();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { gameplayRequests: string[] }).gameplayRequests.filter((x) =>
            x.startsWith("/api/gameplay/sessions/s0/frames:all:"),
          ).length,
      ),
    )
    .toBe(4);
  const beforeCapture = await page.evaluate(
    () =>
      (window as unknown as { gameplayRequests: string[] }).gameplayRequests.filter((x) =>
        x.startsWith("/api/gameplay/sessions/s0/frames:all:"),
      ).length,
  );
  await expect(page.getByText(/of 1000/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /page/i })).toHaveCount(0);
  await page
    .getByRole("button", { name: /Inspect frame/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { gameplayCaptures: number }).gameplayCaptures),
    )
    .toBe(1);
  await expect(page.getByRole("button", { name: "Back to frames" })).toBeVisible();
  await expect(page.getByText("Hand #h0", { exact: true }).first()).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { gameplayRequests: string[] }).gameplayRequests.filter((x) =>
          x.startsWith("/api/gameplay/sessions/s0/frames:all:"),
        ).length,
    ),
  ).toBe(beforeCapture);
  await page.getByRole("button", { name: "Back to frames" }).click();
  await page.getByRole("button", { name: "Refresh frames" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { gameplayRequests: string[] }).gameplayRequests.filter(
            (x) => x === "/api/gameplay/sessions/s0/frames:all:0",
          ).length,
      ),
    )
    .toBe(2);
  await page.getByRole("button", { name: "Recorded hand" }).click();
  await page.getByRole("button", { name: "Hand #h0 · 1" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { gameplayRequests: string[] }).gameplayRequests.some((x) =>
          x.includes("/frames:h0:"),
        ),
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Recorded hand" }).click();
  await page.getByRole("button", { name: "All frames" }).click();
  await page.getByRole("button", { name: "Recording session" }).click();
  await page.getByRole("button", { name: "Session 1 · 1000 frames" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { gameplayRequests: string[] }).gameplayRequests.some((x) =>
          x.includes("/sessions/s1/frames:"),
        ),
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Recording session" }).click();
  await page.getByRole("button", { name: "Session 0 · 1000 frames" }).click();
  await page.getByRole("radio", { name: "Games view" }).click();
  await expect(page.getByLabel("Recorded games")).toBeVisible();
  await page.setViewportSize({ width: 700, height: 720 });
  await expect(page.getByRole("button", { name: /Open game/ }).first()).toBeVisible();
  const gameBox = await page.locator(".gameplay-game-card").first().boundingBox();
  const gameListBox = await page.getByLabel("Recorded games").boundingBox();
  expect(
    gameBox && gameListBox && gameBox.width <= gameListBox.width && gameBox.width >= 180,
  ).toBeTruthy();
  await page.getByRole("button", { name: "Rename recording" }).click();
  await page.getByLabel("Recording name to rename").fill("Renamed");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("button", { name: "Recording session" })).toHaveText("Renamed");
  await page.getByRole("button", { name: "Manage recordings" }).click();
  await page.getByRole("button", { name: "Archive current recording" }).click();
  await page.getByRole("button", { name: "Manage recordings" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { gameplayRequests: string[] }).gameplayRequests.filter((x) =>
            x.startsWith("/api/gameplay:1:"),
          ).length,
      ),
    )
    .toBeGreaterThanOrEqual(4);
  expect(await page.getByLabel("Archived recordings").getByRole("button").count()).toBeLessThan(50);
  await page.getByRole("button", { name: /Renamed · 1000 frames/ }).click();
  await page.getByRole("button", { name: "Restore selected" }).click();
  await expect(page.getByRole("button", { name: "Recording session" })).toHaveText("Renamed");
});
