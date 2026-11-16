import { expect, test, type Page } from "@playwright/test";
import { installLabFixture } from "./fixture.js";

async function installFixtureWith(page: Page, setup: () => void) {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${setup.toString()})();`,
  });
}

test("Games and Frames recover from summary read conflicts without manual refresh", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installFixtureWith(page, () => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    const calls: Record<string, number> = {};
    const writes: string[] = [];
    Object.assign(window, { summaryRecovery: { calls, writes } });
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      if (request.method !== "GET") writes.push(request.path);
      const success = (body: unknown) => ({ status: 200, headers: {}, body });
      if (request.path === "/api/gameplay/frames/retry-frame")
        return success({
          frame: {
            id: "retry-frame",
            session_id: "retry",
            hand_id: "123",
            captured_at: "2026-11-13T00:00:00Z",
            ocr_status: "complete",
            error: null,
            width: 100,
            height: 50,
            image_url:
              "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='50'/%3E",
          },
        });
      if (request.path === "/api/gameplay")
        return success({
          sessions:
            request.query.archived === "1"
              ? []
              : [
                  {
                    id: "retry",
                    name: "Retry recording",
                    source: "TEST-1",
                    status: "stopped",
                    interval_ms: 1000,
                    created_at: "2026-11-13T00:00:00Z",
                    frame_count: 1,
                    hand_count: 1,
                  },
                ],
        });
      if (/^\/api\/gameplay\/sessions\/retry(?:\/frames)?$/.test(request.path)) {
        const key = `${request.path}:${request.query.background_page === "1" ? "paged" : "direct"}`;
        calls[key] = (calls[key] ?? 0) + 1;
        if (calls[key] <= 2)
          return {
            status: 409,
            headers: {},
            body: { error: "Frame evidence changed during summary read; retry" },
          };
        const items = request.path.endsWith("/frames")
          ? [
              {
                id: "retry-frame",
                session_id: "retry",
                hand_id: "123",
                captured_at: "2026-11-13T00:00:00Z",
                ocr_status: "complete",
                error: null,
                width: 100,
                height: 50,
                image_url:
                  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='50'/%3E",
              },
            ]
          : [
              {
                hand_id: "123",
                frame_count: 1,
                first_at: "2026-11-13T00:00:00Z",
                last_at: "2026-11-13T00:00:00Z",
              },
            ];
        return success({
          items,
          hands: items,
          frames: items,
          nextCursor: null,
          hasMore: false,
          total: 1,
          meta: {},
        });
      }
      return previous(request);
    };
  });
  await page.goto("/gameplay");
  await page.getByRole("radio", { name: "Games view" }).click();
  await expect(page.getByRole("button", { name: /Open game/ }).first()).toBeVisible();
  await page.getByRole("radio", { name: "Frames view" }).click();
  await expect(page.getByRole("button", { name: /Inspect frame/ }).first()).toBeVisible();
  await expect(page.locator(".gameplay-error")).toHaveCount(0);
  const result = await page.evaluate(
    () =>
      (
        window as unknown as {
          summaryRecovery: { calls: Record<string, number>; writes: string[] };
        }
      ).summaryRecovery,
  );
  expect(result.calls["/api/gameplay/sessions/retry:paged"]).toBe(3);
  expect(result.calls["/api/gameplay/sessions/retry/frames:paged"]).toBe(3);
  expect(result.writes).toEqual([]);
  await page.screenshot({ path: "test-results/summary-conflict-recovered.png" });
  expect(errors).toEqual([]);
});

test("Gameplay pages eagerly, preserves its snapshot and manages catalogs", async ({ page }) => {
  await installFixtureWith(page, () => {
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
  await expect(page.getByRole("button", { name: "Back to frames" })).toBeVisible();
  await expect(page.getByText("Hand #h0", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Back to frames" }).click();
  await page.getByRole("radio", { name: "Recording view" }).click();
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { gameplayCaptures: number }).gameplayCaptures),
    )
    .toBe(1);
  await page.getByRole("radio", { name: "Frames view" }).click();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { gameplayRequests: string[] }).gameplayRequests.filter((x) =>
          x.startsWith("/api/gameplay/sessions/s0/frames:all:"),
        ).length,
    ),
  ).toBe(beforeCapture);
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

test("Gameplay keeps startup visible until its first recordings page resolves", async ({
  page,
}) => {
  await installFixtureWith(page, () => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.assign(window, {
      releaseGameplayStartup: () => {
        release();
      },
    });
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      if (request.path === "/api/gameplay" && request.query.background_page === "1") await gate;
      return previous(request);
    };
  });
  await page.goto("/gameplay");
  await expect(page.locator(".gameplay-workspace")).toBeVisible();
  await expect(page.locator("#loading-overlay")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { releaseGameplayStartup: () => void }).releaseGameplayStartup();
  });
  await expect(page.locator("#loading-overlay")).toBeHidden();
});

test("one recording menu includes Tigard and both legacy imports and preserves navigation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await installFixtureWith(page, () => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    const sessions = [
      { id: "tigard", name: "11/13/26 - Tigard #17", frame_count: 332 },
      { id: "legacy-a", name: "Legacy recording A", frame_count: 3000 },
      {
        id: "legacy-b",
        name: "Legacy recording B with a deliberately long source dataset name for overflow coverage",
        frame_count: 2545,
      },
      { id: "archived", name: "Archived recording", frame_count: 10 },
      { id: "archived-2", name: "Archived recording 2", frame_count: 80 },
      { id: "archived-3", name: "Archived recording 3", frame_count: 100 },
      { id: "archived-4", name: "Archived recording 4", frame_count: 101 },
    ].map((item, index) => ({
      ...item,
      collection_id: item.id.startsWith("legacy-") ? "legacy" : "current",
      archived: item.id.startsWith("archived"),
      source: item.id.startsWith("legacy-") ? `legacy-benchmark:${item.id}` : "TEST-1",
      interval_ms: 1000,
      status: "stopped",
      created_at: index === 0 ? "2026-11-13T00:00:00Z" : "2026-11-15T00:00:00Z",
      hand_count: 1,
    }));
    if (!localStorage.getItem("poker-lab:workspace:v1"))
      localStorage.setItem(
        "poker-lab:workspace:v1",
        JSON.stringify({
          gameplay: { sessionId: "tigard", collectionId: "legacy", view: "games" },
        }),
      );
    const requests = JSON.parse(
      localStorage.getItem("recording-menu-requests") || "[]",
    ) as string[];
    Object.assign(window, { recordingMenuRequests: requests });
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      const success = (body: unknown) => ({ status: 200, headers: {}, body });
      if (!request.path.startsWith("/api/gameplay")) return previous(request);
      requests.push(`${request.method} ${request.path} ${JSON.stringify(request.query)}`);
      localStorage.setItem("recording-menu-requests", JSON.stringify(requests));
      if (request.path === "/api/gameplay/collections")
        return success({
          collections: [
            {
              id: "current",
              name: "Gameplay",
              kind: "recordings",
              archived: false,
              recording_count: 1,
              frame_count: 332,
            },
            {
              id: "legacy",
              name: "LegacyBenchmark",
              kind: "recordings",
              archived: false,
              recording_count: 2,
              frame_count: 5545,
            },
          ],
          default_collection_id: "current",
        });
      if (request.path === "/api/gameplay") {
        const items = [...sessions]
          .sort((left, right) => right.created_at.localeCompare(left.created_at))
          .filter(
            (item) =>
              item.archived === (request.query.archived === "1") &&
              (!request.query.collection_id || item.collection_id === request.query.collection_id),
          );
        return success({ items, nextCursor: null, hasMore: false, total: items.length, meta: {} });
      }
      const selected = sessions.find((item) =>
        request.path.startsWith(`/api/gameplay/sessions/${item.id}`),
      );
      if (selected) {
        const frame = {
          id: `${selected.id}-frame`,
          session_id: selected.id,
          hand_id: selected.id,
          captured_at: "2026-11-13T00:00:00Z",
          ocr_status: "complete",
          error: null,
          image_url:
            "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='50'/%3E",
          width: 100,
          height: 50,
        };
        if (request.path.endsWith("/frames"))
          return success({
            items: [frame],
            frames: [frame],
            nextCursor: null,
            hasMore: false,
            total: 1,
            meta: {},
          });
        return success({
          session: selected,
          items: [
            {
              hand_id: selected.id,
              frame_count: 1,
              first_at: selected.created_at,
              last_at: selected.created_at,
            },
          ],
          nextCursor: null,
          hasMore: false,
          total: 1,
          meta: {},
        });
      }
      return previous(request);
    };
  });
  await page.goto("/gameplay");
  const picker = page.getByRole("button", { name: "Recording session", exact: true });
  await expect(picker).toHaveText("11/13/26 - Tigard #17");
  await expect(page.getByLabel("Gameplay collection", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Recorded games")).toBeVisible();
  await picker.click();
  const menu = page.getByLabel("Recording sessions", { exact: true });
  await expect(menu.getByRole("button")).toHaveText([
    "11/13/26 - Tigard #17 · 332 frames",
    "Legacy recording A · 3000 frames",
    "Legacy recording B with a deliberately long source dataset name for overflow coverage · 2545 frames",
  ]);
  await expect(menu.getByText("Archived recording")).toHaveCount(0);
  await page.screenshot({ path: ".notes/recording-menu-desktop.png" });
  for (const name of [
    "Legacy recording A",
    "Legacy recording B with a deliberately long source dataset name for overflow coverage",
  ]) {
    await menu.getByRole("button", { name: new RegExp(name) }).click();
    await expect(picker).toHaveText(name);
    await expect(page.getByRole("button", { name: /Open game/ }).first()).toBeVisible();
    await expect(
      page.getByText(`Game #${name.endsWith("A") ? "legacy-a" : "legacy-b"}`, { exact: true }),
    ).toBeVisible();
    await page.getByRole("radio", { name: "Frames view" }).click();
    await expect(page.getByRole("button", { name: /Inspect frame/ }).first()).toBeVisible();
    await page.reload();
    await expect(picker).toHaveText(name);
    await expect(page.getByRole("radio", { name: "Frames view" })).toBeChecked();
    await expect(page.getByRole("button", { name: /Inspect frame/ }).first()).toBeVisible();
    await page.getByRole("radio", { name: "Games view" }).click();
    await page.reload();
    await expect(picker).toHaveText(name);
    await expect(page.getByLabel("Recorded games")).toBeVisible();
    await picker.click();
  }
  await menu.getByRole("button", { name: /11\/13\/26 - Tigard #17/ }).click();
  await expect(picker).toHaveText("11/13/26 - Tigard #17");
  await page.reload();
  await expect(picker).toHaveText("11/13/26 - Tigard #17");
  await expect(page.getByLabel("Recorded games")).toBeVisible();
  for (const width of [700, 390]) {
    await page.setViewportSize({ width, height: 720 });
    await picker.click();
    const legacyButton = menu.getByRole("button", { name: /Legacy recording B/ });
    await expect(legacyButton).toBeVisible();
    await expect(legacyButton).toHaveAttribute(
      "title",
      "Legacy recording B with a deliberately long source dataset name for overflow coverage",
    );
    expect(
      await legacyButton.evaluate((element) => ({
        clipped: element.scrollWidth > element.clientWidth,
        overflow: getComputedStyle(element).textOverflow,
      })),
    ).toEqual({ clipped: true, overflow: "ellipsis" });
    const bounds = await menu.boundingBox();
    expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width).toBeTruthy();
    await page.screenshot({ path: `.notes/recording-menu-${width}.png` });
    await page.keyboard.press("Escape");
  }
  await page.getByRole("radio", { name: "Recording view" }).click();
  await expect(page.locator(".gameplay-recording-panel").getByRole("radio")).toHaveCount(0);
  const requests = await page.evaluate(
    () => (window as unknown as { recordingMenuRequests: string[] }).recordingMenuRequests,
  );
  expect(requests.some((item) => item.includes('"collection_id"'))).toBe(false);
  expect(requests.some((item) => /\/ai\//.test(item))).toBe(false);
  expect(requests.some((item) => item.startsWith("POST"))).toBe(false);
  expect(errors).toEqual([]);
});
