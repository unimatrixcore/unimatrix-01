import { expect, test, type Page } from "@playwright/test";
import { installLabFixture } from "./fixture.js";

function installLayoutFixture(startInReview = true, holdContinuation = false, slowReview = false) {
  const previous = window.__POKER_LAB_TEST_INVOKE__!;
  const summary = { total: 320, pending: 0, reviewed: 320, captures: 1, revision: 1 };
  const sample = (n: number) => ({
    id: "pot",
    queue_id: n + 1,
    sample_key: `sample-${n}`,
    base64_image: "",
    image_url: "/layout-crop.svg",
    label: "G 10",
    reviewed: true,
    discarded: false,
  });
  const entry = (n: number) => ({ id: "pot", filename: `item-${n}.png`, label: "G 10" });
  const success = (body: unknown) => ({ status: 200, headers: {}, body });
  window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
    if (request.path === "/api/initial_data") {
      const response = (await previous(request)) as { body: Record<string, unknown> };
      return {
        ...response,
        body: {
          ...response.body,
          db: Array.from({ length: 320 }, (_, n) => entry(n)),
          session: {
            queue_mode: "paged",
            frames: [],
            pool: [sample(0)],
            queue_summary: summary,
            review_batch: { mode: "stream", batch_id: "layout-run", next_cursor: null },
            review_stats: { total: 320, pending: 0 },
            reviewUnlocked: startInReview,
          },
          collection_page: {
            items: Array.from({ length: 40 }, (_, n) => sample(n)),
            next_cursor: null,
            summary,
          },
        },
      };
    }
    if (
      request.query.background_page === "1" &&
      ["/api/db_entries", "/api/queue", "/api/queue/review/items"].includes(request.path)
    ) {
      if (
        slowReview &&
        request.path === "/api/queue/review/items" &&
        request.query.cursor === "80"
      ) {
        Object.assign(window, { reviewContinuationDelayed: true });
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      if (holdContinuation && request.path === "/api/queue" && request.query.cursor === "80") {
        await new Promise<void>((resolve) => {
          Object.assign(window, { releaseLayoutContinuation: resolve });
        });
      }
      const offset = Number(request.query.cursor || 0),
        end = Math.min(320, offset + 80);
      return success({
        items: Array.from({ length: end - offset }, (_, n) =>
          request.path === "/api/db_entries" ? entry(offset + n) : sample(offset + n),
        ),
        nextCursor: end < 320 ? String(end) : null,
        hasMore: end < 320,
        total: 320,
        meta: { summary, review_stats: { total: 320, pending: 0 } },
      });
    }
    return previous(request);
  };
}

async function install(
  page: Page,
  startInReview = true,
  holdContinuation = false,
  slowReview = false,
) {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${installLayoutFixture.toString()})(${startInReview}, ${holdContinuation}, ${slowReview});`,
  });
  await page.route(/\/api\/db_image\/|\/layout-crop\.svg/, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="50"><text x="10" y="32" fill="white">G 10</text></svg>',
    }),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function expectSettledFirstRow(page: Page, host: string, view: string) {
  const list = page.locator(`#${host}`);
  const first = list.locator(".card").first();
  await expect(first).toBeVisible();
  await expect
    .poll(() =>
      first
        .locator("img")
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  // ResizeObserver-driven virtual measurements can land after the image's load event.
  await expect
    .poll(() =>
      list.evaluate(async (node) => {
        const sample = () => {
          const row = node.querySelector<HTMLElement>('[data-index="0"]');
          const card = row?.querySelector<HTMLElement>(".card");
          const main = document.getElementById("main-content")!;
          const header = document.querySelector(
            `#view-${node.id === "db-list" ? "database" : node.id === "session-review-list" ? "session-review" : "collection"} .view-header`,
          )!;
          return {
            top: card?.getBoundingClientRect().top,
            height: row?.getBoundingClientRect().height,
            scroll: main.scrollTop,
            header: header?.getBoundingClientRect().bottom ?? 0,
          };
        };
        const before = sample();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const after = sample();
        return (
          JSON.stringify(before) === JSON.stringify(after) &&
          after.top !== undefined &&
          after.top >= after.header &&
          after.scroll === 0
        );
      }),
    )
    .toBe(true);
  const identity =
    view === "database"
      ? "data-filename"
      : view === "session-review"
        ? "data-review-key"
        : "data-sample-key";
  await expect(first).toHaveAttribute(identity, view === "database" ? "item-0.png" : "sample-0");
}

for (const [view, host] of [
  ["database", "db-list"],
  ["session-review", "session-review-list"],
  ["collection", "frame-list"],
] as const) {
  test(`${view} preserves the original grid and page scroll ownership`, async ({
    page,
  }, testInfo) => {
    await install(page, view !== "collection");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/collection");
    await expect(page.locator("#loading-overlay")).toBeHidden();
    if (view !== "collection") await page.locator(`#nav-${view}`).click();
    const list = page.locator(`#${host}`),
      cards = list.locator(".card");
    await expect(cards.first()).toBeVisible();
    await expect(list.locator("[data-list-count]")).toHaveAttribute("data-list-count", "320");
    const geometry = await list.evaluate((node) => {
      const cards = [...node.querySelectorAll<HTMLElement>(".card")];
      const first = cards[0]!.getBoundingClientRect();
      const main = document.getElementById("main-content")!;
      return {
        first: { top: first.top, width: first.width, height: first.height },
        width: node.getBoundingClientRect().width,
        columns: cards.filter((card) => card.getBoundingClientRect().top === first.top).length,
        mainTop: main.scrollTop,
        listOverflow: getComputedStyle(node.querySelector('[role="list"]')!).overflowY,
        headerBottom:
          document
            .querySelector(
              `#view-${node.id === "db-list" ? "database" : node.id === "session-review-list" ? "session-review" : "collection"} .view-header`,
            )
            ?.getBoundingClientRect().bottom ?? 0,
      };
    });
    expect(geometry.columns).toBe(4);
    expect(geometry.width).toBe(1072);
    expect(geometry.first.width).toBe(259);
    expect(geometry.first.height).toBe(view === "database" ? 240.796875 : 209);
    expect(geometry.first.top).toBeGreaterThanOrEqual(geometry.headerBottom);
    expect(geometry.mainTop).toBe(0);
    expect(geometry.listOverflow).toBe("visible");
    expect(await cards.count()).toBeLessThan(100);
    await expect
      .poll(() =>
        cards
          .first()
          .locator("img")
          .evaluate((node) => {
            const image = node as HTMLImageElement;
            return image.complete && image.naturalWidth > 0;
          }),
      )
      .toBe(true);
    await expectSettledFirstRow(page, host, view);
    await page.screenshot({ path: testInfo.outputPath(`${view}-wide.png`) });
    if (view === "session-review") {
      const rail = page
        .getByRole("navigation")
        .filter({ has: page.getByRole("link", { name: "Gameplay" }) });
      await rail.getByRole("link", { name: "Gameplay" }).click();
      await expect(page.locator(".gameplay-workspace")).toBeVisible();
      await rail.getByRole("link", { name: "OCR Data" }).click();
      await expectSettledFirstRow(page, host, view);
      await page.screenshot({ path: testInfo.outputPath("session-review-warm.png") });
    }
    const main = page.locator("#main-content");
    await main.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    const last =
      view === "database"
        ? list.locator('[data-filename="item-319.png"]')
        : view === "session-review"
          ? list.locator('[data-review-key="sample-319"]')
          : list.locator('[data-sample-key="sample-319"]');
    await expect(last).toBeInViewport({ ratio: 1 });
    await expect
      .poll(() => last.evaluate((node) => node.getBoundingClientRect().bottom))
      .toBeLessThanOrEqual(1000);
    if (view === "collection") {
      const dock = await page.locator("#record-dock").boundingBox();
      const final = await last.boundingBox();
      expect(final!.y + final!.height).toBeLessThanOrEqual(dock!.y);
    }
    await page.screenshot({ path: testInfo.outputPath(`${view}-last.png`) });
    await main.evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBe(0);
    await expect(cards.first()).toBeVisible();
    await page.setViewportSize({ width: 700, height: 720 });
    await expect
      .poll(() => cards.first().evaluate((node) => node.getBoundingClientRect().width))
      .toBeGreaterThan(200);
    const narrow = await cards.first().boundingBox();
    const second = await cards.nth(1).boundingBox();
    expect(second!.y).toBe(narrow!.y);
    expect(second!.x + second!.width).toBeLessThanOrEqual(700);
    await page.screenshot({ path: testInfo.outputPath(`${view}-narrow.png`) });
    expect(errors).toEqual([]);
  });
}

test("Review first row stays visible while images and virtual rows settle", async ({ page }) => {
  await install(page, true, false, true);
  await page.route("**/layout-crop.svg", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="50"><text x="10" y="32">G 10</text></svg>',
    });
  });
  await page.goto("/collection");
  await expect(page.locator("#loading-overlay")).toBeHidden();
  await page.evaluate(() => {
    const result: Array<{ top: number; header: number; scroll: number }> = [];
    Object.assign(window, { reviewGeometry: result, reviewGeometryDone: false });
    const start = performance.now();
    const sample = () => {
      const card = document.querySelector<HTMLElement>(
        '#session-review-list [data-index="0"] .card',
      );
      const image = card?.querySelector("img");
      const header = document.querySelector<HTMLElement>("#view-session-review .view-header");
      const main = document.getElementById("main-content")!;
      if (
        card &&
        image?.complete &&
        image.naturalWidth &&
        header &&
        card.getClientRects().length &&
        getComputedStyle(document.getElementById("view-session-review")!).display !== "none"
      ) {
        result.push({
          top: card.getBoundingClientRect().top,
          header: header.getBoundingClientRect().bottom,
          scroll: main.scrollTop,
        });
      }
      if (performance.now() - start < 2500) requestAnimationFrame(sample);
      else Object.assign(window, { reviewGeometryDone: true });
    };
    requestAnimationFrame(sample);
  });
  await page.locator("#nav-session-review").click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { reviewGeometryDone: boolean }).reviewGeometryDone,
      ),
    )
    .toBe(true);
  const samples = await page.evaluate(
    () =>
      (
        window as unknown as {
          reviewGeometry: Array<{ top: number; header: number; scroll: number }>;
        }
      ).reviewGeometry,
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { reviewContinuationDelayed: boolean }).reviewContinuationDelayed,
    ),
  ).toBe(true);
  expect(samples.length).toBeGreaterThan(10);
  expect(samples.filter((sample) => sample.top < sample.header || sample.scroll !== 0)).toEqual([]);
});

test("shared grid is painted behind Poker content", async ({ page }) => {
  await install(page);
  await page.goto("/collection");
  await expect(page.locator("#loading-overlay")).toBeHidden();
  const region = { x: 90, y: 300, width: 100, height: 200 };
  const grid = await page.screenshot({ clip: region });
  const hide = await page.addStyleTag({
    content: "body.grid-backdrop::before { visibility:hidden!important }",
  });
  const hidden = await page.screenshot({ clip: region });
  expect(grid.equals(hidden)).toBe(false);
  await hide.evaluate((node) => {
    node.parentNode?.removeChild(node);
  });
  const restored = await page.screenshot({ clip: region });
  expect(grid.equals(restored)).toBe(true);
  const stacking = await page.addStyleTag({
    content: "body.grid-backdrop { isolation:auto!important }",
  });
  const covered = await page.screenshot({ clip: region });
  const removeBackdrop = await page.addStyleTag({
    content: "body.grid-backdrop::before { visibility:hidden!important }",
  });
  expect(covered.equals(await page.screenshot({ clip: region }))).toBe(true);
  expect(grid.equals(covered)).toBe(false);
  await stacking.evaluate((node) => {
    node.parentNode?.removeChild(node);
  });
  await removeBackdrop.evaluate((node) => {
    node.parentNode?.removeChild(node);
  });
});

test("database preserves selection, edit drafts and intentional page scroll", async ({ page }) => {
  await install(page);
  await page.goto("/collection");
  await expect(page.locator("#loading-overlay")).toBeHidden();
  await page.locator("#nav-database").click();
  const first = page.locator('#db-list [data-filename="item-0.png"]');
  await first.getByRole("checkbox").check();
  await first.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(first.locator("input.card-label")).toBeFocused();
  await first.locator("input.card-label").fill("G 42");
  const main = page.locator("#main-content");
  await main.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(page.locator('#db-list [data-filename="item-319.png"]')).toBeVisible();
  await expect(first).toHaveCount(0);
  await main.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(first.getByRole("checkbox")).toBeChecked();
  await expect(first.locator("input.card-label")).toHaveValue("G 42");
  await first.locator("input.card-label").press("Escape");
  await main.evaluate((node) => {
    node.scrollTop = 400;
  });
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBe(400);
  await page.reload();
  await expect(page.locator("#loading-overlay")).toBeHidden();
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBe(400);
  await page.locator("#nav-session-review").click();
  await expect(page.locator("#session-review-list .card").first()).toBeVisible();
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBe(0);
});

test("continuation feedback clears the dock with the original page scroll owner", async ({
  page,
}) => {
  await install(page, false, true);
  await page.setViewportSize({ width: 420, height: 760 });
  await page.goto("/collection");
  await expect(page.locator("#loading-overlay")).toBeHidden();
  const main = page.locator("#main-content");
  const status = page.locator(".collection-virtual-list").getByRole("status");
  await main.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(status).toBeInViewport();
  const feedback = await status.boundingBox(),
    dock = await page.locator("#record-dock").boundingBox();
  expect(feedback!.y + feedback!.height).toBeLessThanOrEqual(dock!.y);
  await page.evaluate(() => {
    (window as unknown as { releaseLayoutContinuation: () => void }).releaseLayoutContinuation();
  });
  await expect(page.locator("#frame-list [data-list-count]")).toHaveAttribute(
    "data-list-count",
    "320",
  );
});

test("full review retains selection, draft and edit focus across virtual rows", async ({
  page,
}) => {
  await install(page);
  await page.goto("/collection");
  await expect(page.locator("#loading-overlay")).toBeHidden();
  await page.locator("#nav-session-review").click();
  const first = page.locator('#session-review-list [data-review-key="sample-0"]');
  await first.getByRole("checkbox").check();
  await first.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(first.locator("input.card-label")).toBeFocused();
  await first.locator("input.card-label").fill("G 42");
  await page.locator("#main-content").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(
    page.locator('#session-review-list [data-review-key="sample-319"]'),
  ).toBeInViewport();
  await expect(first).toHaveCount(0);
  await page.locator("#main-content").evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(first.getByRole("checkbox")).toBeChecked();
  await expect(first.locator("input.card-label")).toHaveValue("G 42");
  await expect(first.locator("input.card-label")).toBeFocused();
});
