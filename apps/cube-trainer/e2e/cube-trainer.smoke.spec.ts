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

  await expect(main.getByRole("heading", { name: "Cube Trainer" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Learn" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Drill" })).toBeVisible();

  expectNoPageErrors(pageErrors);
});

test("Drill flow: drill and case picker", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  const main = page.locator("main");

  await gotoRoute(page, "/drill");

  await expect(main.getByRole("heading", { name: "Drilling" })).toBeVisible();
  await expect(main.getByText("Next case")).toBeVisible();

  await main.getByRole("button", { name: "Choose cases" }).click();
  await expect(main.getByRole("heading", { name: "Choose cases" })).toBeVisible();
  await expect(main.getByRole("button", { name: "OLL 1", exact: true })).toBeVisible();

  await main.getByRole("group").getByRole("button", { name: "PLL" }).click();
  await expect(main.getByRole("button", { name: "PLL Ua", exact: true })).toBeVisible();

  expectNoPageErrors(pageErrors);
});

test("Learn flow: guided session and case picker", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  const main = page.locator("main");

  await gotoRoute(page, "/learn");

  await expect(main.getByRole("heading", { name: "Learning" })).toBeVisible();
  await expect(main.getByText("Mark learned")).toBeVisible();

  await main.getByRole("button", { name: "Choose cases" }).click();
  await expect(main.getByRole("heading", { name: "Choose cases" })).toBeVisible();
  await expect(main.getByRole("button", { name: "OLL 1", exact: true })).toBeVisible();

  await main.getByRole("group").getByRole("button", { name: "PLL" }).click();
  await expect(main.getByRole("button", { name: "PLL Gd", exact: true })).toBeVisible();

  expectNoPageErrors(pageErrors);
});
