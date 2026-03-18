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
  const primaryNav = page.getByRole("navigation", { name: "Primary" });

  await gotoRoute(page, "/");

  await expect(main.getByRole("heading", { name: "Build systems that survive contact." })).toBeVisible();
  await expect(main.getByRole("link", { name: "Open Explore projects" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Open Read the writing archive" })).toBeVisible();
  await expect(primaryNav.getByRole("link", { exact: true, name: "Projects" })).toBeVisible();

  expectNoPageErrors(pageErrors);
});

test("navigation smoke flow", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  const primaryNav = page.getByRole("navigation", { name: "Primary" });

  await gotoRoute(page, "/");

  await primaryNav.getByRole("link", { exact: true, name: "Projects" }).click();
  await expect(page).toHaveURL(/\/projects$/u);
  await expect(
    page.getByRole("link", { name: "Open project Project in progress" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Open project Project in progress" }).click();
  await expect(page).toHaveURL(/\/projects\/placeholder-project$/u);
  await expect(page.getByRole("heading", { name: "Project in progress" })).toBeVisible();

  await page.getByRole("link", { name: "Back to projects" }).click();
  await expect(page).toHaveURL(/\/projects$/u);

  await primaryNav.getByRole("link", { exact: true, name: "Writing" }).click();
  await expect(page).toHaveURL(/\/blog$/u);
  await expect(
    page.getByRole("link", {
      name: "Open blog entry Post in progress",
    }),
  ).toBeVisible();

  await primaryNav.getByRole("link", { exact: true, name: "About" }).click();
  await expect(page).toHaveURL(/\/about$/u);
  await expect(page.getByRole("heading", { name: /I build reliable TypeScript systems/i })).toBeVisible();

  expectNoPageErrors(pageErrors);
});

test("project page render", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoRoute(page, "/projects/placeholder-project");

  await expect(page.getByText("Project details", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Project in progress" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Full project write-up" })).toBeVisible();
  await expect(page.getByText("This project entry is in standby", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to projects" })).toBeVisible();

  expectNoPageErrors(pageErrors);
});

test("blog page render", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoRoute(page, "/blog/placeholder-post");

  await expect(page.getByText("Writing view", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Post in progress" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Full article" })).toBeVisible();
  await expect(page.getByText("This post is queued for writing.", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to writing" })).toBeVisible();

  expectNoPageErrors(pageErrors);
});
