import { writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { installLabFixture } from "./fixture.js";

const evidence = "../../.orchestration/evidence/poker-startup-browser";
type Scenario = "held" | "populated" | "empty" | "list-error" | "initial-error";

async function fixture(page: Page, scenario: Scenario, holdDecode = false) {
  page.on("pageerror", (error) => {
    test.info().annotations.push({ type: "pageerror", description: error.stack || error.message });
  });
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${installStartupFixture.toString()})(${JSON.stringify(scenario)}, ${holdDecode});`,
  });
  await page.route("**/startup-crop-*.svg*", async (route) => {
    const index = Number(new URL(route.request().url()).pathname.match(/crop-(\d+)/)?.[1]);
    if (scenario === "held" && index === 0)
      await page.waitForFunction(
        () =>
          (window as unknown as { startupFixture: { releaseImage: boolean } }).startupFixture
            .releaseImage,
        undefined,
        { timeout: 20000 },
      );
    await route.fulfill({
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="#39206d"/><text x="12" y="54" fill="#ffffff" font-size="38">${68 + index} BB</text></svg>`,
    });
  });
}

function installStartupFixture(scenario: Scenario, holdDecode: boolean) {
  const previous = window.__POKER_LAB_TEST_INVOKE__!;
  const summary = {
    total: scenario === "empty" ? 0 : 120,
    pending: scenario === "empty" ? 0 : 120,
    reviewed: 0,
    captures: scenario === "empty" ? 0 : 1,
    revision: 1,
  };
  const state = {
    releaseFirst: scenario !== "held",
    releaseDecode: !holdDecode,
    releaseImage: scenario !== "held",
    releaseContinuation: scenario !== "held",
    calls: [] as string[],
    events: [] as Array<{
      name: string;
      at: number;
      visibleImages?: number;
      loadedImages?: number;
    }>,
  };
  Object.assign(window, { startupFixture: state });
  const event = (name: string) => state.events.push({ name, at: performance.now() });
  if (holdDecode) {
    const { value: decode } = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "decode",
    ) as { value: (this: HTMLImageElement) => Promise<void> };
    HTMLImageElement.prototype.decode = async function () {
      await decode.call(this);
      if (this.src.includes("startup-crop-0.svg")) {
        event("first-image-decode-requested");
        while (!state.releaseDecode) await new Promise((resolve) => setTimeout(resolve, 10));
        event("first-image-decoded");
      }
    };
  }
  const gate = async (key: "releaseFirst" | "releaseContinuation") => {
    while (!state[key]) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  document.addEventListener(
    "load",
    (event) => {
      if (event.target instanceof HTMLImageElement && event.target.src.includes("startup-crop"))
        state.events.push({
          name: `image-load:${new URL(event.target.src).pathname}`,
          at: performance.now(),
        });
    },
    true,
  );
  let wasActive = true;
  new MutationObserver(() => {
    const overlay = document.getElementById("loading-overlay");
    if (!overlay) return;
    const active = overlay.classList.contains("active");
    if (wasActive && !active) {
      const images = [
        ...document.querySelectorAll<HTMLImageElement>("#frame-list .card img"),
      ].filter((image) => {
        const rect = image.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
      });
      state.events.push({
        name: "overlay-dismissed",
        at: performance.now(),
        visibleImages: images.length,
        loadedImages: images.filter((image) => image.complete && image.naturalWidth > 0).length,
      });
    }
    wasActive = active;
  }).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
    if (request.path === "/api/initial_data") {
      if (scenario === "initial-error")
        return { status: 503, headers: {}, body: { error: "Startup fixture unavailable" } };
      const response = (await previous(request)) as { body: Record<string, unknown> };
      return {
        ...response,
        body: {
          ...response.body,
          session: { queue_mode: "paged", frames: [], pool: [], queue_summary: summary },
          collection_page: { items: [], next_cursor: null, summary },
        },
      };
    }
    if (request.path === "/api/queue" && request.query.background_page === "1") {
      const cursor = Number(request.query.cursor || 0);
      state.calls.push(String(cursor));
      event(`list-request:${cursor}`);
      if (scenario === "held") await gate(cursor === 0 ? "releaseFirst" : "releaseContinuation");
      if (scenario === "list-error")
        return { status: 503, headers: {}, body: { error: "List fixture unavailable" } };
      const count = scenario === "empty" ? 0 : 60;
      const items = Array.from({ length: count }, (_, i) => ({
        id: "pot",
        queue_id: cursor + i + 1,
        sample_key: `startup-${cursor + i}`,
        base64_image: "",
        image_url: `/startup-crop-${cursor + i}.svg`,
        reviewed: false,
        label: "",
      }));
      event(`list-response:${cursor}`);
      return {
        status: 200,
        headers: {},
        body: {
          items,
          nextCursor: count && cursor === 0 ? "60" : null,
          hasMore: !!count && cursor === 0,
          total: summary.total,
          meta: { summary },
        },
      };
    }
    return previous(request);
  };
}

async function snapshot(page: Page, name: string) {
  await page.screenshot({ path: `${evidence}/${name}.png` });
  const details = JSON.stringify(
    await page.evaluate(() => ({
      viewport: {
        width: innerWidth,
        height: innerHeight,
        scrollY,
        scrollWidth: document.documentElement.scrollWidth,
      },
      geometry: Object.fromEntries(
        [
          "#frame-list [role=list]",
          "#record-dock",
          "#frame-list .collection-crop-card:first-child",
          '#frame-list [data-sample-key="startup-119"]',
        ].map((selector) => {
          const node = document.querySelector(selector);
          return [
            selector,
            node
              ? {
                  ...node.getBoundingClientRect().toJSON(),
                  scrollTop: node.scrollTop,
                  scrollHeight: node.scrollHeight,
                }
              : null,
          ];
        }),
      ),
      events: (window as unknown as { startupFixture?: { events: unknown[] } }).startupFixture
        ?.events,
    })),
    null,
    2,
  );
  await writeFile(`${evidence}/${name}.json`, details);
  await test.info().attach(name, { body: details, contentType: "application/json" });
}

test("launch never paints raw legacy controls while scripts and styles are delayed", async ({
  page,
}) => {
  await fixture(page, "empty");
  let releaseScripts!: () => void;
  let releaseStyles!: () => void;
  const scripts = new Promise<void>((resolve) => {
    releaseScripts = resolve;
  });
  const styles = new Promise<void>((resolve) => {
    releaseStyles = resolve;
  });
  await page.route(/\/assets\/.*\.(js|css)(\?|$)/, async (route) => {
    await (route.request().resourceType() === "stylesheet" ? styles : scripts);
    await route.continue();
  });
  await page.goto("/collection", { waitUntil: "commit" });
  try {
    await expect(page.locator("#loading-overlay")).toBeVisible();
    await expect(page.locator("#modal-overlay")).toBeHidden();
    await expect(page.locator("#tool-shell")).toBeHidden();
    releaseStyles();
    await expect(page.locator("#loading-overlay")).toHaveCSS("position", "fixed");
    await expect(page.locator("#modal-overlay")).toBeHidden();
    expect(
      await page.evaluate(
        () =>
          document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest("#loading-overlay")
            ?.id,
      ),
    ).toBe("loading-overlay");
    await snapshot(page, "styles-ready-scripts-held");
  } finally {
    releaseScripts();
    releaseStyles();
  }
  await expect(page.getByText("No crops collected", { exact: true })).toBeVisible();
});

for (const holdDecode of [false, true]) {
  test(`startup covers held first page and visible image ${holdDecode ? "decode" : "load"} but not a held continuation`, async ({
    page,
  }) => {
    await fixture(page, "held", holdDecode);
    await page.goto("/collection");
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { startupFixture: { calls: string[] } }).startupFixture.calls,
        ),
      )
      .toContain("0");
    await snapshot(page, "first-list-held");
    await expect.soft(page.locator("#loading-overlay"), "first list is unresolved").toBeVisible();
    await page.evaluate(() => {
      (
        window as unknown as { startupFixture: { releaseFirst: boolean } }
      ).startupFixture.releaseFirst = true;
    });
    const image = page.locator('#frame-list img[src*="startup-crop-0.svg"]');
    await expect(image).toBeVisible();
    expect(
      await image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0),
    ).toBe(false);
    await snapshot(page, "visible-image-held");
    await expect
      .soft(page.locator("#loading-overlay"), "first visible image is unresolved")
      .toBeVisible();
    await page.evaluate(() => {
      (
        window as unknown as { startupFixture: { releaseImage: boolean } }
      ).startupFixture.releaseImage = true;
    });
    await expect
      .poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth))
      .toBe(240);
    if (holdDecode) {
      await expect
        .poll(() =>
          page.evaluate(() =>
            (
              window as unknown as { startupFixture: { events: Array<{ name: string }> } }
            ).startupFixture.events.some((event) => event.name === "first-image-decode-requested"),
          ),
        )
        .toBe(true);
      await expect(page.locator("#loading-overlay")).toBeVisible();
      await snapshot(page, "visible-image-decode-held");
      await page.evaluate(() => {
        (
          window as unknown as { startupFixture: { releaseDecode: boolean } }
        ).startupFixture.releaseDecode = true;
      });
    }
    await expect(page.locator("#loading-overlay")).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { startupFixture: { calls: string[] } }).startupFixture.calls,
        ),
      )
      .toContain("60");
    await snapshot(page, "first-viewport-ready-continuation-held");
    const state = await page.evaluate(
      () =>
        (
          window as unknown as {
            startupFixture: {
              releaseContinuation: boolean;
              events: Array<{
                name: string;
                at: number;
                visibleImages?: number;
                loadedImages?: number;
              }>;
            };
          }
        ).startupFixture,
    );
    expect(state.releaseContinuation).toBe(false);
    const dismissed = state.events.find((event) => event.name === "overlay-dismissed")!;
    expect(dismissed.visibleImages).toBeGreaterThan(0);
    expect(dismissed.loadedImages).toBe(dismissed.visibleImages);
    expect(dismissed.at).toBeGreaterThanOrEqual(
      state.events.find((event) => event.name === "image-load:/startup-crop-0.svg")!.at,
    );
  });
}

test("continuation loading feedback stays above the dock on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 760 });
  await fixture(page, "held");
  await page.goto("/collection");
  await page.evaluate(() => {
    Object.assign((window as unknown as { startupFixture: object }).startupFixture, {
      releaseFirst: true,
      releaseImage: true,
    });
  });
  await expect(page.locator("#loading-overlay")).toBeHidden();
  const list = page.locator("#main-content");
  const status = page.locator(".collection-virtual-list").getByRole("status");
  await expect
    .poll(async () => {
      await list.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      return await status.count();
    })
    .toBe(1);
  await expect(status).toHaveText("Loading more…");
  await expect(status).toBeInViewport();
  const feedback = await status.boundingBox();
  const dock = await page.locator("#record-dock").boundingBox();
  expect(feedback!.y + feedback!.height).toBeLessThanOrEqual(dock!.y);
  await page.screenshot({ path: `${evidence}/continuation-status-420.png` });
});

for (const scenario of ["empty", "list-error", "initial-error"] as const) {
  test(`${scenario} startup terminates with a visible state`, async ({ page }) => {
    await fixture(page, scenario);
    await page.goto("/collection");
    await expect(page.locator("#loading-overlay")).toBeHidden({ timeout: 15000 });
    if (scenario === "empty")
      await expect(page.getByText("No crops collected", { exact: true })).toBeVisible();
    else if (scenario === "list-error") {
      await expect(page.locator("#frame-list").getByRole("alert")).toBeVisible();
      await expect(
        page.locator("#frame-list").getByRole("button", { name: "Retry" }),
      ).toBeVisible();
    } else await expect(page.locator(".toast.error")).toBeVisible();
    await snapshot(page, scenario);
  });
}

test("collection scrolls behind the fixed dock and its last row clears it after narrow resize", async ({
  page,
}) => {
  await fixture(page, "populated");
  await page.goto("/collection");
  const list = page.locator("#main-content");
  await expect(page.locator("#frame-list .collection-crop-card").first()).toBeVisible();
  await expect(page.locator("#loading-overlay")).toBeHidden();
  for (const size of [
    { width: 1280, height: 900 },
    { width: 760, height: 700 },
    { width: 420, height: 760 },
  ]) {
    await page.setViewportSize(size);
    await snapshot(page, `resized-${size.width}`);
    await expect(page.locator('#frame-list [role="list"]')).toHaveCSS("overflow-y", "visible");
    await expect
      .poll(() =>
        list.evaluate((node) => Math.abs(node.getBoundingClientRect().bottom - innerHeight)),
      )
      .toBeLessThanOrEqual(2);
    const dock = page.locator("#record-dock");
    await expect(dock).toHaveCSS("position", "fixed");
    const bounds = await dock.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width);
    await list.evaluate((node) => {
      node.scrollTop = node.scrollHeight / 2;
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const dock = document.getElementById("record-dock")!.getBoundingClientRect();
          for (const card of document.querySelectorAll("#frame-list .collection-crop-card")) {
            const rect = card.getBoundingClientRect();
            const x = Math.max(rect.left, dock.left) + 3;
            const y = Math.max(rect.top, dock.top) + 3;
            if (
              x < Math.min(rect.right, dock.right) &&
              y < Math.min(rect.bottom, dock.bottom) &&
              document.elementFromPoint(x, y)?.closest("#record-dock")
            )
              return true;
          }
          return false;
        }),
      )
      .toBe(true);
    await snapshot(page, `mid-scroll-${size.width}`);

    const last = page.locator('#frame-list .collection-crop-card[data-sample-key="startup-119"]');
    await expect
      .poll(
        async () => {
          await list.evaluate((node) => {
            node.scrollTop = node.scrollHeight;
          });
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => {
                    resolve();
                  });
                }),
              ),
          );
          const remaining = await list.evaluate(
            (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
          );
          const card = await last.boundingBox();
          const panel = await dock.boundingBox();
          return remaining > 1 || !card ? Infinity : card.y + card.height - panel!.y;
        },
        { message: "last row must be reachable above dock without scrolling the window" },
      )
      .toBeLessThanOrEqual(-1);
    await expect(last).toBeInViewport({ ratio: 1 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await snapshot(page, `end-scroll-${size.width}`);
  }
});
