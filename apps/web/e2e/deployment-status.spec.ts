import { expect, test } from "@playwright/test";

function publicStatus(state: "up" | "down" | "degraded" = "up") {
  const today = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  return {
    apps: [
      {
        displayName: "Unimatrix",
        state,
        lastCheckedAt: Math.floor(Date.now() / 60_000) * 60_000,
        history: Array.from({ length: 30 }, (_, index) => ({
          from: today - (29 - index) * 86_400_000,
          to: today - (28 - index) * 86_400_000,
          uptimePercent: index < 2 ? null : index === 9 ? 98.2 : 100,
          coveragePercent: index < 2 ? 0 : index === 4 ? 50 : 100,
        })),
        summary: { uptimePercent: 99.94, coveragePercent: 93.33 },
      },
    ],
  };
}

test("status uses the approved layout and 30 accessible daily bars on desktop and mobile", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/deployment/status", (route) => route.fulfill({ json: publicStatus() }));
  await page.goto("/status");
  await expect(page.getByRole("heading", { name: "Unimatrix Status" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "All services operational" })).toBeVisible();
  const history = page.getByRole("group", { name: "Unimatrix daily uptime" });
  await expect(history.getByRole("button")).toHaveCount(30);
  await expect(history.getByRole("button", { name: /No observations/ })).toHaveCount(2);
  await expect(history.getByRole("button").nth(4).locator("span")).toHaveCSS("height", "14px");
  await history.getByRole("button").first().focus();
  await expect(page.getByRole("tooltip")).toContainText("No observations");
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("contentinfo")).toContainText(/©.*Gwen Phalan/);
  await expect(page.getByRole("link", { name: /Main site/ })).toHaveAttribute(
    "href",
    "https://unimatrix-01.dev",
  );
  const header = await page.locator("header").boundingBox();
  const overall = await page.getByRole("status").boundingBox();
  const list = await page.getByRole("list", { name: "Services" }).boundingBox();
  expect(header?.y).toBeLessThan(125);
  expect(overall?.y).toBeGreaterThan((header?.y ?? 0) + (header?.height ?? 0));
  expect(list?.y).toBeGreaterThan((overall?.y ?? 0) + (overall?.height ?? 0) + 60);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(history.getByRole("button")).toHaveCount(30);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("refresh replaces previous healthy data with an unavailable state and can recover", async ({
  page,
}) => {
  let fail = false;
  await page.route("**/deployment/status", (route) =>
    fail
      ? route.fulfill({ status: 503, json: { message: "Unavailable" } })
      : route.fulfill({ json: publicStatus("degraded") }),
  );
  await page.goto("/status");
  await expect(page.getByRole("heading", { name: "Some services degraded" })).toBeVisible();
  fail = true;
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Status unavailable" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Services" })).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Some services degraded" })).toBeVisible();
});

test("the status hostname root reaches status without requesting homepage content", async ({
  page,
}) => {
  let contentRequests = 0;
  await page.route("http://status.unimatrix-01.dev/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/content/")) contentRequests++;
    const response = await page.request.get(`http://localhost:4173${url.pathname}${url.search}`);
    await route.fulfill({ response });
  });
  await page.route("**/deployment/status", (route) => route.fulfill({ json: publicStatus() }));
  await page.goto("http://status.unimatrix-01.dev/");
  await expect(page).toHaveURL("http://status.unimatrix-01.dev/status");
  await expect(page.getByRole("heading", { name: "Unimatrix Status" })).toBeVisible();
  expect(contentRequests).toBe(0);
});
