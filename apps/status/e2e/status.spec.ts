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
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Unimatrix Status" })).toBeVisible();
  await expect(page).toHaveURL("http://localhost:4177/");
  await expect(page.getByRole("heading", { name: "All services operational" })).toBeVisible();
  const history = page.getByRole("group", { name: "Unimatrix daily uptime" });
  await expect(history.getByRole("button")).toHaveCount(30);
  await expect(history.getByRole("button", { name: /No observations/ })).toHaveCount(2);
  await expect(history.getByRole("button").nth(4).locator("span")).toHaveCSS("height", "14px");
  await history.getByRole("button").first().focus();
  await expect(page.getByRole("tooltip")).toContainText("No observations");
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("contentinfo")).toContainText(/©.*Gwen Phalan/);
  await expect(page.getByRole("link", { name: /Main site/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Gwen Phalan/ })).toHaveAttribute(
    "href",
    "https://unimatrix-01.dev",
  );
  const header = await page.locator("header").boundingBox();
  const overall = await page.getByRole("status").boundingBox();
  const list = await page.getByRole("list", { name: "Services" }).boundingBox();
  expect(header?.y).toBeLessThan(125);
  expect(overall?.y).toBeGreaterThan((header?.y ?? 0) + (header?.height ?? 0));
  expect(list?.y).toBeGreaterThan((overall?.y ?? 0) + (overall?.height ?? 0) + 60);
  const footer = page.getByRole("contentinfo");
  const desktopFooter = await footer.boundingBox();
  expect(Math.round((desktopFooter?.y ?? 0) + (desktopFooter?.height ?? 0))).toBe(
    page.viewportSize()!.height - 24,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(history.getByRole("button")).toHaveCount(30);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const mobileFooter = await footer.boundingBox();
  expect(Math.round((mobileFooter?.y ?? 0) + (mobileFooter?.height ?? 0))).toBe(844 - 16);
  await page.setViewportSize({ width: 390, height: 400 });
  await footer.scrollIntoViewIfNeeded();
  const compactFooter = await footer.boundingBox();
  const compactList = await page.getByRole("list", { name: "Services" }).boundingBox();
  expect(compactFooter!.y).toBeGreaterThan(compactList!.y + compactList!.height);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(400);
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
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Some services degraded" })).toBeVisible();
  fail = true;
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Status unavailable" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Services" })).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Some services degraded" })).toBeVisible();
});

test("root reload preserves the standalone status surface", async ({ page }) => {
  await page.route("**/deployment/status", (route) => route.fulfill({ json: publicStatus() }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Unimatrix Status" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Unimatrix Status" })).toBeVisible();
  await expect(page).toHaveURL("http://localhost:4177/");
  await expect(page).toHaveTitle("Unimatrix Status");
});
