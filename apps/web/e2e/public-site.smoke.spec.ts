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

  await expect(main.getByRole("heading", { name: "Passionate developer who loves clean code and synergy." })).toBeVisible();
  await expect(main.getByRole("link", { name: "View all projects" })).toBeVisible();
  await expect(main.getByRole("link", { name: "View all blog posts" })).toBeVisible();

  expectNoPageErrors(pageErrors);
});

test("navigation smoke flow", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  const main = page.locator("main");

  await gotoRoute(page, "/");

  await main.getByRole("link", { name: "View all projects" }).click();
  await expect(page).toHaveURL(/\/projects$/u);
  await expect(
    page.getByRole("link", { name: "Open project Cube Trainer" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Open project Cube Trainer" }).click();
  await expect(page).toHaveURL(/\/projects\/cube-trainer$/u);
  await expect(page.getByRole("heading", { name: "Cube Trainer" })).toBeVisible();

  await page.getByRole("link", { name: "Back to projects" }).click();
  await expect(page).toHaveURL(/\/projects$/u);

  await gotoRoute(page, "/blog");
  await expect(page).toHaveURL(/\/blog$/u);
  await expect(
    page.getByRole("link", {
      name: "Open blog entry Post in progress",
    }),
  ).toBeVisible();

  await gotoRoute(page, "/about");
  await expect(page).toHaveURL(/\/about$/u);
  await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Draft an email" })).toBeVisible();

  expectNoPageErrors(pageErrors);
});

test("project page render", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoRoute(page, "/projects/cube-trainer");

  await expect(page.getByRole("heading", { name: "Cube Trainer" })).toBeVisible();
  await expect(
    page.getByText("A flashcard trainer for memorizing every 3x3 Rubik's Cube OLL and PLL algorithm.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Visit site" })).toHaveAttribute(
    "href",
    "https://cube.unimatrix-01.dev",
  );
  await expect(page.getByRole("link", { name: "Back to projects" })).toBeVisible();
  await expect(page.getByText(/^(Checking|Live|Offline)$/u)).toBeVisible();

  expectNoPageErrors(pageErrors);
});

test("blog page render", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoRoute(page, "/blog/placeholder-post");

  await expect(page.getByRole("heading", { name: "Post in progress" })).toBeVisible();
  await expect(page.getByText("This post is still being drafted. It will be published when it is ready.", { exact: false })).toBeVisible();
  await expect(page.getByText("This post is a placeholder while the draft is still in progress.", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to blog" })).toBeVisible();

  expectNoPageErrors(pageErrors);
});
