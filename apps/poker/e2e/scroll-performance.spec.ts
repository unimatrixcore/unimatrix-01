import { expect, test } from "@playwright/test";
import { installLabFixture } from "./fixture.js";

for (const view of ["collection", "database"] as const) {
  test(`${view} wheel scrolling during eager loading`, async ({ page }) => {
    const hostId = view === "collection" ? "frame-list" : "db-list";
    const resource = view === "collection" ? "/api/queue" : "/api/db_entries";
    await page.addInitScript({
      content: `(${installLabFixture.toString()})(); (${((resource: string) => {
        const previous = window.__POKER_LAB_TEST_INVOKE__!;
        const summary = { total: 1200, pending: 1200, reviewed: 0, captures: 1, revision: 1 };
        window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
          if (request.path === "/api/initial_data") {
            const result = (await previous(request)) as { body: Record<string, unknown> };
            return {
              ...result,
              body: {
                ...result.body,
                session: { queue_mode: "paged", frames: [], pool: [], queue_summary: summary },
                collection_page: { items: [], next_cursor: null, summary },
              },
            };
          }
          if (request.path === resource && request.query.background_page === "1") {
            const cursor = Number(request.query.cursor || 0);
            await new Promise((resolve) => setTimeout(resolve, 250));
            const items = Array.from({ length: 100 }, (_, i) =>
              resource === "/api/db_entries"
                ? { filename: `entry-${cursor + i}.png`, id: "pot", label: "G 10" }
                : {
                    id: "pot",
                    queue_id: cursor + i + 1,
                    sample_key: `sample-${cursor + i}`,
                    image_url: `/fixture-image/${cursor + i}.png`,
                    base64_image: "",
                    reviewed: false,
                  },
            );
            return {
              status: 200,
              headers: {},
              body: {
                items,
                nextCursor: cursor < 1100 ? String(cursor + 100) : null,
                hasMore: cursor < 1100,
                total: 1200,
                meta: { summary },
              },
            };
          }
          return previous(request);
        };
      }).toString()})(${JSON.stringify(resource)});`,
    });
    let imageRequests = 0;
    await page.route(/\/fixture-image\/|\/api\/db_image\//, async (route) => {
      imageRequests++;
      await new Promise((resolve) => setTimeout(resolve, 180));
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="48"><rect width="160" height="48" fill="white"/></svg>',
      });
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
    });
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(`/${view}`);
    await expect(page.locator(`#${hostId} .card`).first()).toBeVisible();
    await expect(page.locator("#loading-overlay")).toBeHidden();
    await page.evaluate((hostId) => {
      const data = {
        frames: [] as number[],
        long: [] as number[],
        heights: [] as number[],
        offsets: [] as number[],
        changes: [] as [number, number][],
        mounts: 0,
      };
      Object.assign(window, { scrollPerf: data });
      const sizes = new WeakMap<Element, number>();
      const observer = new ResizeObserver((entries) => {
        for (const e of entries) {
          const old = sizes.get(e.target);
          const height = e.contentRect.height;
          if (old !== undefined && Math.abs(old - height) > 1) data.changes.push([old, height]);
          sizes.set(e.target, height);
        }
      });
      const scan = () => {
        document.querySelectorAll(`#${hostId} [data-native-card]`).forEach((el) => {
          if (!sizes.has(el)) {
            sizes.set(el, el.getBoundingClientRect().height);
            data.mounts++;
            observer.observe(el);
          }
        });
      };
      new MutationObserver(scan).observe(document.getElementById(hostId)!, {
        subtree: true,
        childList: true,
      });
      scan();
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) data.long.push(e.duration);
      }).observe({ entryTypes: ["longtask"] });
      let last = 0;
      function frame(t: number) {
        if (last) data.frames.push(t - last);
        last = t;
        const row = document.querySelector<HTMLElement>(`#${hostId} [data-index]`);
        if (row) data.heights.push(row.getBoundingClientRect().height);
        data.offsets.push(document.getElementById("main-content")!.scrollTop);
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }, hostId);
    await page.locator("#main-content").hover();
    for (let i = 0; i < 45; i++) {
      await page.mouse.wheel(0, 180);
      await page.waitForTimeout(45);
    }
    await expect(page.locator(`#${hostId} [data-list-complete="true"]`)).toBeAttached({
      timeout: 15000,
    });
    await expect(page.locator(`#${hostId} [data-list-count]`)).toHaveAttribute(
      "data-list-count",
      "1200",
    );
    const result = await page.evaluate(
      () =>
        (
          window as unknown as {
            scrollPerf: {
              frames: number[];
              long: number[];
              heights: number[];
              offsets: number[];
              changes: [number, number][];
              mounts: number;
            };
          }
        ).scrollPerf,
    );
    console.log(
      "SCROLL_PERF",
      JSON.stringify({
        view,
        frames: result.frames.length,
        maxGap: Math.max(...result.frames),
        gapsOver32: result.frames.filter((x) => x > 32).length,
        longTasks: result.long,
        heightTransitions: result.changes.filter(([before, after]) => before > 0 && after > 0)
          .length,
        mounts: result.mounts,
        imageRequests,
        heights: [...new Set(result.heights)],
        backwards: result.offsets.filter((x, i, a) => i > 0 && x < (a[i - 1] ?? x) - 2).length,
        final: result.offsets.at(-1),
      }),
    );
    expect(result.offsets.at(-1)).toBeGreaterThan(1000);
    expect(result.mounts).toBeGreaterThan(30);
    expect(result.changes.filter(([before, after]) => before > 0 && after > 0).length).toBe(0);
    expect(imageRequests).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
}

test("mixed collection cards retain their own height when another page arrives", async ({
  page,
}) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      const summary = { total: 24, pending: 12, reviewed: 12, captures: 1, revision: 1 };
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      Object.assign(window, { releaseMixedPage: () => release?.() });
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.path === "/api/initial_data") {
          const result = (await previous(request)) as { body: Record<string, unknown> };
          return {
            ...result,
            body: {
              ...result.body,
              session: { queue_mode: "paged", frames: [], pool: [], queue_summary: summary },
              collection_page: { items: [], next_cursor: null, summary },
            },
          };
        }
        if (request.query.background_page === "1" && request.path === "/api/db_entries") {
          const items = Array.from({ length: 8 }, (_, i) => ({
            id: "pot",
            filename: `mixed-db-${i}.png`,
            label: i % 2 ? "123" : "",
          }));
          return {
            status: 200,
            headers: {},
            body: { items, nextCursor: null, hasMore: false, total: items.length, meta: {} },
          };
        }
        if (request.query.background_page === "1" && request.path === "/api/label_history") {
          return {
            status: 200,
            headers: {},
            body: {
              items: [
                {
                  kind: "event",
                  payload: {
                    id: 1,
                    created_at: "2026-01-01",
                    action: "correct",
                    label: "History label",
                  },
                },
              ],
              nextCursor: null,
              hasMore: false,
              total: 1,
              meta: {},
            },
          };
        }
        if (request.path === "/api/queue" && request.query.background_page === "1") {
          const cursor = Number(request.query.cursor || 0);
          if (cursor) await gate;
          const items = Array.from({ length: 12 }, (_, i) => ({
            id: "pot",
            queue_id: cursor + i + 1,
            sample_key: `mixed-${cursor + i}`,
            image_url: `/mixed-image/${cursor + i}.png`,
            base64_image: "",
            reviewed: i % 2 === 1,
            label: i % 2 === 1 ? "123" : "",
          }));
          return {
            status: 200,
            headers: {},
            body: {
              items,
              nextCursor: cursor ? null : "12",
              hasMore: !cursor,
              total: 24,
              meta: { summary },
            },
          };
        }
        return previous(request);
      };
    }).toString()})();`,
  });
  await page.route("**/mixed-image/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="48"/>',
    });
  });
  await page.goto("/collection");
  const short = page.locator('[data-sample-key="mixed-0"]').locator("..");
  const tall = page.locator('[data-sample-key="mixed-1"]').locator("..");
  await expect(short).toBeVisible();
  await expect(tall).toBeVisible();
  await page.waitForTimeout(500);
  const before = await Promise.all([
    short.evaluate((el) => el.getBoundingClientRect().height),
    tall.evaluate((el) => el.getBoundingClientRect().height),
  ]);
  await page.evaluate(() => {
    (window as unknown as { releaseMixedPage: () => void }).releaseMixedPage();
  });
  await expect(page.locator('#frame-list [data-list-complete="true"]')).toBeAttached();
  await page.waitForTimeout(300);
  const after = await Promise.all([
    short.evaluate((el) => el.getBoundingClientRect().height),
    tall.evaluate((el) => el.getBoundingClientRect().height),
  ]);
  console.log("MIXED_HEIGHTS", JSON.stringify({ before, after }));
  expect(before[0]).toBeLessThan(before[1]);
  expect(after).toEqual(before);

  await page.locator("#nav-database").click();
  const first = page.locator('#db-list [data-filename="mixed-db-0.png"]');
  const second = page.locator('#db-list [data-filename="mixed-db-1.png"]');
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await first.getByText("Review history", { exact: true }).click();
  await expect(first.locator(".card-history")).toContainText("History label");
  await first.getByText("Review history", { exact: true }).click();
  await expect(first.locator(".card-history")).not.toHaveAttribute("open");
  await second.getByRole("button", { name: "Edit", exact: true }).click();
  const input = second.locator("input.card-label");
  await expect(input).toBeFocused();
  await input.fill("456");
  await first.getByText("Review history", { exact: true }).click();
  await expect(first.locator(".card-history")).toContainText("History label");
  await expect(input).toHaveValue("456");
});
