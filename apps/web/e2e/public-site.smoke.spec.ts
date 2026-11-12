import { expect, test, type Page } from "@playwright/test";

import {
  collectPageErrors,
  expectNoAccessibilityViolations,
  expectNoPageErrors,
  gotoRoute,
} from "@unimatrix/e2e-helpers";

import { stubContentApi } from "./fixtures/content-api";

/**
 * Empty, and meant to stay that way. This list held `region`, `heading-order`,
 * and `landmark-unique`; all three are fixed, so the baseline is now a hard
 * floor rather than a backlog.
 *
 * A fourth, `page-has-heading-one`, was never in the list and was failing
 * anyway — `/projects` and `/blog` were visited by the smoke flow but never
 * scanned. Both are scanned now.
 *
 * Adding an entry here should be a deliberate, explained edit. It means
 * shipping a known structural problem, and it is the kind of change that is
 * easy to make quietly to turn a build green.
 *
 * It stays app-local rather than moving into `@unimatrix/e2e-helpers` alongside
 * the scanner: a baseline shared with cflop would let a suppression added
 * for one app silently lower the floor for the other.
 */
const KNOWN_BEST_PRACTICE_VIOLATIONS: readonly string[] = [];

async function scanAccessibility(page: Page, routeLabel: string) {
  await expectNoAccessibilityViolations(page, routeLabel, KNOWN_BEST_PRACTICE_VIOLATIONS);
}

test("homepage load", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await stubContentApi(page);
  const main = page.locator("main");

  await gotoRoute(page, "/");

  await expect(
    main.getByRole("heading", { name: "Projects I need and no one wants." }),
  ).toBeVisible();
  await expect(main.getByRole("link", { name: "View all projects" })).toBeVisible();
  await expect(main.getByRole("link", { name: "View all blog posts" })).toBeVisible();

  await scanAccessibility(page, "/");
  expectNoPageErrors(pageErrors);
});

test("navigation smoke flow", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await stubContentApi(page);
  const main = page.locator("main");

  await gotoRoute(page, "/");

  await main.getByRole("link", { name: "View all projects" }).click();
  await expect(page).toHaveURL(/\/projects$/u);
  await expect(page.getByRole("link", { name: "Open project CFLOP" })).toBeVisible();

  // The list routes were previously visited here but never scanned, so
  // `page-has-heading-one` failed on both of them without failing the build.
  await scanAccessibility(page, "/projects");

  await page.getByRole("link", { name: "Open project CFLOP" }).click();
  await expect(page).toHaveURL(/\/projects\/cflop$/u);
  await expect(page.getByRole("heading", { name: "CFLOP" })).toBeVisible();

  await page.getByRole("link", { name: "Back to projects" }).click();
  await expect(page).toHaveURL(/\/projects$/u);

  await gotoRoute(page, "/blog");
  await expect(page).toHaveURL(/\/blog$/u);
  await expect(
    page.getByRole("link", {
      name: "Open blog entry Placeholder blog",
    }),
  ).toBeVisible();

  await scanAccessibility(page, "/blog");

  await gotoRoute(page, "/about");
  await expect(page).toHaveURL(/\/about$/u);
  await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Draft an email" })).toBeVisible();

  await scanAccessibility(page, "/about");
  expectNoPageErrors(pageErrors);
});

test("project page render", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await stubContentApi(page);

  await gotoRoute(page, "/projects/cflop");

  await expect(page.getByRole("heading", { name: "CFLOP" })).toBeVisible();
  await expect(
    page.getByText(
      "A flashcard trainer for memorizing every 3x3 Rubik's Cube OLL and PLL algorithm.",
      {
        exact: false,
      },
    ),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Visit site" })).toHaveAttribute(
    "href",
    "https://cflop.unimatrix-01.dev",
  );
  await expect(page.getByRole("link", { name: "Back to projects" })).toBeVisible();
  await expect(page.getByText(/^(Checking|Live|Offline)$/u)).toBeVisible();

  await scanAccessibility(page, "/projects/cflop");
  expectNoPageErrors(pageErrors);
});

test("blog page render", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await stubContentApi(page);

  await gotoRoute(page, "/blog/placeholder-post");

  await expect(page.getByRole("heading", { name: "Placeholder blog" })).toBeVisible();
  await expect(
    page.getByText(
      "This is explicitly a placeholder blog post. A real post will replace it later.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("This is a placeholder blog post while I figure out what belongs here.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to blog" })).toBeVisible();

  await scanAccessibility(page, "/blog/placeholder-post");
  expectNoPageErrors(pageErrors);
});

test("loads the markdown renderer only when a content detail needs it", async ({ page }) => {
  const scripts: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/assets/public-markdown-")) scripts.push(request.url());
  });
  await stubContentApi(page);
  await gotoRoute(page, "/");
  await expect(
    page.getByRole("heading", { name: "Projects I need and no one wants." }),
  ).toBeVisible();
  expect(scripts).toHaveLength(0);
  await gotoRoute(page, "/blog/placeholder-post");
  await expect(
    page.getByText("This is a placeholder blog post while I figure out what belongs here.", {
      exact: false,
    }),
  ).toBeVisible();
  expect(scripts).toHaveLength(1);
});
