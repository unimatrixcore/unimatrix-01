import { expect, test, type Page } from "@playwright/test";

function collectPageErrors(page: Page): Error[] {
  const pageErrors: Error[] = [];

  page.on("pageerror", (error) => {
    pageErrors.push(error);
  });

  return pageErrors;
}

function expectNoPageErrors(pageErrors: Error[]) {
  expect(
    pageErrors.map((error) => error.message),
    "Expected the route interaction to finish without uncaught page errors.",
  ).toEqual([]);
}

async function gotoRoute(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
}

test("homepage load", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  const main = page.locator("main");

  await gotoRoute(page, "/");

  await expect(
    main.getByRole("heading", { name: "Learn and train 3x3 last-layer algorithms." }),
  ).toBeVisible();
  await expect(main.getByRole("link", { name: /Train OLL/u })).toBeVisible();
  await expect(main.getByRole("link", { name: /Train PLL/u })).toBeVisible();

  expectNoPageErrors(pageErrors);
});

test("OLL trainer flow", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  const main = page.locator("main");

  await gotoRoute(page, "/oll");

  await expect(main.getByRole("heading", { name: "OLL", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reveal algorithm" })).toBeVisible();

  await page.getByRole("button", { name: "Reveal algorithm" }).click();
  await expect(page.getByRole("button", { name: "Got it" })).toBeVisible();

  await page.getByRole("button", { name: "Browse" }).click();
  await expect(main.getByText("Dot", { exact: true }).first()).toBeVisible();
  await expect(main.getByText("OLL 1", { exact: true })).toBeVisible();

  expectNoPageErrors(pageErrors);
});

test("PLL browse list renders all cases", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  const main = page.locator("main");

  await gotoRoute(page, "/pll");
  await page.getByRole("button", { name: "Browse" }).click();

  await expect(main.getByText("PLL Ua", { exact: true })).toBeVisible();
  await expect(main.getByText("PLL Gd", { exact: true })).toBeVisible();

  expectNoPageErrors(pageErrors);
});
