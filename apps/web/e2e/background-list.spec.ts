import { expect, test, type Page } from "@playwright/test";

async function pagedBlog(page: Page, requests: number[], total = 150) {
  await page.route("**/api/content/posts?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const cursor = params.get("cursor");
    const offset = cursor === null ? 0 : Number((JSON.parse(cursor) as [string, string])[1]);
    const limit = Number(params.get("limit") ?? 50);
    requests.push(offset);
    if (offset > 0) await new Promise((resolve) => setTimeout(resolve, 150));
    const count = Math.min(limit, total - offset);
    const posts = Array.from({ length: count }, (_, index) => {
      const number = offset + index + 1;
      return {
        id: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
        type: "blog",
        slug: `record-${number}`,
        title: `Record ${number}`,
        summary: "A paged record.",
        description: null,
        publicationState: "published",
        publishedAt: "2026-11-01",
        featured: false,
        projectStatus: null,
        repoUrl: null,
        liveUrl: null,
        updatedAt: "2026-11-01T00:00:00.000Z",
      };
    });
    await route.fulfill({
      json: {
        posts,
        nextCursor:
          offset + count < total ? JSON.stringify(["2026-11-01", String(offset + count)]) : null,
      },
    });
  });
}

test("paints page one, drains without scrolling, and keeps geometry stable", async ({ page }) => {
  const requests: number[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await pagedBlog(page, requests);
  await page.goto("/blog");
  const list = page.getByRole("list", { name: "Blog posts" });
  await expect(list.getByRole("heading", { name: "Record 1", exact: true })).toBeVisible();
  expect(requests).toEqual([0]);
  const before = await list.evaluate((element) => ({
    top: element.scrollTop,
    width: element.clientWidth,
  }));
  await expect.poll(() => requests.length).toBe(3);
  await expect.poll(() => list.locator('[aria-setsize="150"]').count()).toBeGreaterThan(0);
  expect(await list.getByRole("listitem").count()).toBeLessThan(20);
  expect(
    await list.evaluate((element) => ({ top: element.scrollTop, width: element.clientWidth })),
  ).toEqual(before);
  expect(await list.evaluate((element) => getComputedStyle(element).scrollbarGutter)).toBe(
    "stable",
  );
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(list.getByRole("heading", { name: "Record 150", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(list.getByRole("heading", { name: "Record 150", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/instant-list-blog-mobile.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("save-data disables eager draining until scroll intent", async ({ page }) => {
  const requests: number[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: { saveData: true, effectiveType: "4g" },
    });
  });
  await pagedBlog(page, requests);
  await page.goto("/blog");
  const list = page.getByRole("list", { name: "Blog posts" });
  await expect(list.getByRole("heading", { name: "Record 1", exact: true })).toBeVisible();
  await page.waitForTimeout(600);
  expect(requests).toEqual([0]);
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => requests.length).toBe(2);
  await page.waitForTimeout(600);
  expect(requests).toEqual([0, 50]);
});

test("a failed background page preserves rows and exposes an explicit retry", async ({ page }) => {
  const requests: number[] = [];
  let failing = true;
  let failures = 0;
  await pagedBlog(page, requests);
  await page.route("**/api/content/posts?*", async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor") && failing) {
      failures++;
      await route.fulfill({
        status: 503,
        headers: { "Retry-After": "0" },
        json: { error: { message: "Busy" } },
      });
    } else {
      await route.fallback();
    }
  });
  await page.goto("/blog");
  await expect(page.getByRole("heading", { name: "Record 1", exact: true })).toBeVisible();
  await expect(page.getByText("Could not load more.")).toBeVisible();
  expect(failures).toBe(4);
  await page.waitForTimeout(400);
  expect(failures).toBe(4);
  await expect(page.getByRole("heading", { name: "Record 1", exact: true })).toBeVisible();
  failing = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => requests.length).toBe(3);
  await expect(page.getByText("Could not load more.")).toHaveCount(0);
});

test("revisiting a stale capped catalog refetches its full cached pages", async ({ page }) => {
  const requests: number[] = [];
  const limits: number[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "deviceMemory", { configurable: true, value: 2 });
  });
  await page.clock.install();
  await pagedBlog(page, requests, 600);
  await page.route("**/api/content/posts?*", async (route) => {
    limits.push(Number(new URL(route.request().url()).searchParams.get("limit")));
    await route.fallback();
  });
  await page.goto("/blog");
  await expect(page.getByRole("heading", { name: "Record 1", exact: true })).toBeVisible();
  await expect
    .poll(() => ({ requests: [...requests], limits: [...limits] }), { timeout: 10_000 })
    .toEqual({
      requests: Array.from({ length: 10 }, (_, index) => index * 50),
      limits: Array<number>(10).fill(50),
    });
  await page.waitForTimeout(300);
  expect(limits).toEqual(Array<number>(10).fill(50));
  await page.clock.fastForward(5 * 60_000 + 1);
  await page.locator('a[href="/about"]').first().dispatchEvent("click");
  await expect(page.getByRole("heading", { name: "About", exact: true })).toBeVisible();
  requests.length = 0;
  limits.length = 0;
  await page.locator('a[href="/blog"]').first().dispatchEvent("click");
  await expect
    .poll(() => ({ requests: [...requests], limits: [...limits] }), { timeout: 10_000 })
    .toEqual({
      requests: Array.from({ length: 10 }, (_, index) => index * 50),
      limits: Array<number>(10).fill(50),
    });
  await page.waitForTimeout(300);
  expect(limits).toEqual(Array<number>(10).fill(50));
  expect(requests).toEqual(Array.from({ length: 10 }, (_, index) => index * 50));
  await expect(page.getByRole("heading", { name: "Record 1", exact: true })).toBeVisible();
});
