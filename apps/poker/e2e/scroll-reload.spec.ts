import { expect, test } from "@playwright/test";
import { installLabFixture } from "./fixture.js";

function installReloadFixture({ mode, top }: { mode: string; top: number }) {
  sessionStorage.setItem(
    "collector:current-page-scroll:v1",
    JSON.stringify({
      view: "collection",
      dataset: "fixture",
      top,
      left: 0,
      details: {},
    }),
  );
  if (mode === "memory" || mode === "beyond")
    Object.defineProperty(performance, "memory", {
      configurable: true,
      value: { usedJSHeapSize: 900, jsHeapSizeLimit: 1000 },
    });
  if (mode === "slow-network")
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: { saveData: true, effectiveType: "2g" },
    });
  const previous = window.__POKER_LAB_TEST_INVOKE__!;
  const summary = { total: 2400, pending: 2400, reviewed: 0, captures: 1, revision: 1 };
  window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
    if (request.path === "/api/initial_data") {
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
      const offset = Number(request.query.cursor || 0);
      if (offset && mode === "held") await new Promise<void>(() => {});
      if (offset && mode === "error")
        return { status: 500, headers: {}, body: { error: "Continuation failed" } };
      const count = Math.min(
        Number(request.query.limit || 250),
        mode === "cap" || mode === "slow-network" ? 250 : 80,
      );
      const end = Math.min(2400, offset + count);
      return {
        status: 200,
        headers: {},
        body: {
          items: Array.from({ length: end - offset }, (_, n) => ({
            id: "pot",
            queue_id: offset + n + 1,
            sample_key: `reload-${offset + n}`,
            label: "10",
            reviewed: false,
            discarded: false,
            base64_image: "",
            image_url: "/reload-crop.svg",
          })),
          nextCursor: end < 2400 ? String(end) : null,
          hasMore: end < 2400,
          total: 2400,
          meta: { summary },
        },
      };
    }
    return previous(request);
  };
}

for (const mode of ["held", "memory", "cap", "error", "beyond", "slow-network"]) {
  test(`reload releases its saved viewport while eager loading is ${mode}`, async ({ page }) => {
    await page.addInitScript({
      content: `(${installLabFixture.toString()})(); (${installReloadFixture.toString()})(${JSON.stringify({ mode, top: mode === "beyond" ? 40000 : 600 })});`,
    });
    await page.route("**/reload-crop.svg", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="48"/>',
      }),
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/collection");
    await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
    const list = page.locator("#frame-list [data-list-state]");
    if (mode === "memory" || mode === "beyond")
      await expect(list).toHaveAttribute("data-list-paused", "memory");
    if (mode === "cap" || mode === "slow-network") {
      await expect(list).toHaveAttribute("data-list-count", "2000");
      await expect(list).toHaveAttribute("data-list-paused", "limit");
    }
    if (mode === "error") await expect(list).toHaveAttribute("data-list-state", "error");
    await expect(list).toHaveAttribute("data-list-complete", "false");
    const main = page.locator("#main-content");
    await expect
      .poll(() => page.locator("#view-collection").evaluate((node) => node.style.minHeight))
      .toBe("");
    if (mode !== "beyond")
      await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBe(600);
    else {
      expect(await main.evaluate((node) => node.scrollTop)).toBeLessThan(40000);
      await expect(page.locator("#frame-list [data-native-card]").first()).toBeAttached();
    }
    const next = await main.evaluate((node) => {
      const next = Math.max(
        0,
        Math.min(
          node.scrollTop + (node.scrollTop > 1000 ? -150 : 150),
          node.scrollHeight - node.clientHeight,
        ),
      );
      node.scrollTop = next;
      return next;
    });
    await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBe(next);
    if (mode === "memory" || mode === "cap") {
      const count = Number(await list.getAttribute("data-list-count"));
      await main.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await expect
        .poll(async () => Number(await list.getAttribute("data-list-count")))
        .toBeGreaterThan(count);
    }
    expect(errors).toEqual([]);
  });
}
