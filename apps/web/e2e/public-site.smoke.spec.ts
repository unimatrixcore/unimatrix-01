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

  await expect(main.getByRole("heading", { name: "Build systems that survive contact." })).toBeVisible();
  await expect(main.getByRole("link", { name: "Inspect project nodes" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Read transmissions" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Site navigation" })).toBeVisible();

  expectNoPageErrors(pageErrors);
});

test("navigation smoke flow", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  const siteNavigation = page.getByRole("navigation", { name: "Site navigation" });

  await gotoRoute(page, "/");

  await siteNavigation.getByRole("link", { name: "Projects" }).click();
  await expect(page).toHaveURL(/\/projects$/u);
  await expect(
    page.getByRole("link", { name: "Open project Designation Pending" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Open project Designation Pending" }).click();
  await expect(page).toHaveURL(/\/projects\/placeholder-project$/u);
  await expect(page.getByRole("heading", { name: "Designation Pending" })).toBeVisible();

  await page.getByRole("link", { name: "Back to project index" }).click();
  await expect(page).toHaveURL(/\/projects$/u);

  await siteNavigation.getByRole("link", { name: "Transmissions" }).click();
  await expect(page).toHaveURL(/\/blog$/u);
  await expect(
    page.getByRole("link", {
      name: "Open blog entry Transmission Pending",
    }),
  ).toBeVisible();

  expectNoPageErrors(pageErrors);
});

test("project page render", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoRoute(page, "/projects/placeholder-project");

  await expect(page.getByText("Project node", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Designation Pending" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Full project record" })).toBeVisible();
  await expect(page.getByText("Assimilation continues off-screen.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to project index" })).toBeVisible();

  expectNoPageErrors(pageErrors);
});

test("blog page render", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoRoute(page, "/blog/placeholder-post");

  await expect(page.getByText("Transmission detail", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Transmission Pending" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Authored record" })).toBeVisible();
  await expect(page.getByText("The signal is acknowledged")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to transmission archive" })).toBeVisible();

  expectNoPageErrors(pageErrors);
});
