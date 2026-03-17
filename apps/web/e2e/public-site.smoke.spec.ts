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
    main.getByRole("heading", { name: "What this public route is for" }),
  ).toBeVisible();
  await expect(main.getByRole("link", { name: "Browse projects" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Read the blog" })).toBeVisible();
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
    page.getByRole("link", { name: "Open project Unimatrix-01" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Open project Unimatrix-01" }).click();
  await expect(page).toHaveURL(/\/projects\/unimatrix-01$/u);
  await expect(page.getByRole("heading", { name: "Unimatrix-01" })).toBeVisible();

  await page.getByRole("link", { name: "Back to projects" }).click();
  await expect(page).toHaveURL(/\/projects$/u);

  await siteNavigation.getByRole("link", { name: "Blog" }).click();
  await expect(page).toHaveURL(/\/blog$/u);
  await expect(
    page.getByRole("link", {
      name: "Open blog entry Building a typed content baseline for the new site",
    }),
  ).toBeVisible();

  expectNoPageErrors(pageErrors);
});

test("project page render", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoRoute(page, "/projects/unimatrix-01");

  await expect(page.getByText("Project detail", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Unimatrix-01" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Platform shape" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Ops console topology" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to projects" })).toBeVisible();

  expectNoPageErrors(pageErrors);
});

test("blog page render", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoRoute(page, "/blog/building-a-typed-content-baseline");

  await expect(page.getByText("Blog detail", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Building a typed content baseline for the new site" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Current rollout checklist" }),
  ).toBeVisible();
  await expect(page.locator("table").filter({ hasText: "Safe GFM" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to blog" })).toBeVisible();

  expectNoPageErrors(pageErrors);
});
