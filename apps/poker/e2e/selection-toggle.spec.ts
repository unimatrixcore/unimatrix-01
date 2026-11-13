import { expect, test } from "@playwright/test";
import { installLabFixture } from "./fixture.js";

function installSelectionFixture(count: number, fullReview = true) {
  const previous = window.__POKER_LAB_TEST_INVOKE__!;
  const summary = { total: count, pending: 0, reviewed: count, captures: 1, revision: 1 };
  const crops = Array.from({ length: count }, (_, n) => ({
    id: "seat.0.name",
    queue_id: n + 1,
    sample_key: `selection-${n}`,
    base64_image: "",
    label: n < 2 ? "Alice" : "Bob",
    reviewed: true,
    discarded: false,
  }));
  const success = (body: unknown) => ({ status: 200, headers: {}, body });
  window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
    if (request.path === "/api/initial_data") {
      const response = (await previous(request)) as { body: Record<string, unknown> };
      return {
        ...response,
        body: {
          ...response.body,
          session: {
            queue_mode: fullReview ? "paged" : "legacy",
            frames: [],
            pool: fullReview ? crops.slice(0, 1) : crops,
            queue_summary: summary,
            review_batch: {
              mode: fullReview ? "stream" : "batch",
              batch_id: "selection-run",
              next_cursor: null,
            },
            review_stats: { total: count, pending: 0 },
            reviewUnlocked: true,
          },
          collection_page: { items: [], next_cursor: null, summary },
        },
      };
    }
    if (
      request.query.background_page === "1" &&
      ["/api/queue", "/api/queue/review/items"].includes(request.path)
    ) {
      const matches = crops.filter(
        (crop) =>
          crop.label.toLowerCase().includes((request.query.search || "").toLowerCase()) &&
          (request.query.filter !== "pending" || !crop.reviewed),
      );
      return success({
        items: matches,
        nextCursor: null,
        hasMore: false,
        total: matches.length,
        meta: { summary, review_stats: { total: count, pending: 0 } },
      });
    }
    return previous(request);
  };
}

for (const count of [3, 120]) {
  test(`Review selection toggle reflects individual and bulk selection (${count} crops)`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript({
      content: `(${installLabFixture.toString()})(); (${installSelectionFixture.toString()})(${count});`,
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto("/collection");
    await page.locator("#nav-session-review").click();
    const button = page.locator("#btn-review-select-all");
    const icon = button.locator("..").locator(".review-action-icon svg");
    const checkboxes = page.locator("#session-review-list").getByRole("checkbox");
    await expect(checkboxes.first()).toBeVisible();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(button).toHaveAccessibleName("Select shown");
    await button.locator("..").screenshot({ path: `/tmp/poker-selection-${count}-none.png` });
    const noneIcon = await icon.innerHTML();
    await checkboxes.first().check();
    await expect(button).toHaveAttribute("aria-pressed", "mixed");
    await expect(checkboxes.first()).toBeChecked();
    await button.locator("..").screenshot({ path: `/tmp/poker-selection-${count}-partial.png` });
    const partialIcon = await icon.innerHTML();
    expect(partialIcon).not.toBe(noneIcon);
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(button).toHaveAccessibleName("Deselect shown");
    await expect(page.locator("#btn-delete-session-selected")).toHaveAccessibleName(
      `Remove ${Math.min(100, count)} Selected`,
    );
    await expect(page.locator("#btn-review-deselect-all")).toHaveCount(0);
    await page.locator("#view-session-review .view-header").screenshot({
      path: `/tmp/poker-single-selection-toolbar-${count}.png`,
    });
    await button.locator("..").screenshot({ path: `/tmp/poker-selection-${count}-all.png` });
    const allIcon = await icon.innerHTML();
    expect(allIcon).not.toBe(noneIcon);
    expect(allIcon).not.toBe(partialIcon);
    await expect(checkboxes.first()).toBeChecked();
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(checkboxes.first()).not.toBeChecked();
    await expect(page.locator("#btn-delete-session-selected")).toBeHidden();
    await checkboxes.first().check();
    await checkboxes.first().uncheck();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await page.locator("#review-filter").selectOption("pending");
    await expect(button).toBeHidden();
    await page.locator("#review-filter").selectOption("reviewed");
    await expect(checkboxes.first()).toBeVisible();
    await page.locator("#review-search").fill("Alice");
    await expect(checkboxes).toHaveCount(2);
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    for (const checkbox of await checkboxes.all()) await expect(checkbox).toBeChecked();
    await button.click();
    for (const checkbox of await checkboxes.all()) await expect(checkbox).not.toBeChecked();
    await page.locator("#review-search").fill("no matching crops");
    await expect(button).toBeHidden();
    await page.locator("#review-search").fill("Alice");
    await expect(checkboxes).toHaveCount(2);
    await page.setViewportSize({ width: 640, height: 800 });
    await expect(button).toBeVisible();
    await button.click();
    await expect(button).toHaveAccessibleName("Deselect shown");
    await page.screenshot({ path: testInfo.outputPath("review-selection.png"), fullPage: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    expect(errors).toEqual([]);
  });
}

test("Review reports its cap when a selected crop lies beyond the first hundred targets", async ({
  page,
}) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${installSelectionFixture.toString()})(120);`,
  });
  await page.goto("/review");
  await expect(page.locator("#session-review-list [data-list-count]")).toHaveAttribute(
    "data-list-count",
    "120",
  );
  await page.locator("#main-content").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const outside = page.locator('[data-review-key="selection-100"]').getByRole("checkbox");
  await outside.check();
  const button = page.locator("#btn-review-select-all");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "mixed");
  await expect(page.locator("#toast-container")).toContainText("Select up to 100 crops at a time.");
  await expect(page.locator("#btn-delete-session-selected")).toHaveAccessibleName(
    "Remove 100 Selected",
  );
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "mixed");
  await page.locator("#main-content").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(outside).toBeChecked();
  await outside.uncheck();
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#btn-delete-session-selected")).toBeHidden();
});

test("filtered legacy Review toggle preserves selections outside its targets", async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${installSelectionFixture.toString()})(3, false);`,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/collection");
  await page.locator("#nav-session-review").click();
  const button = page.locator("#btn-review-select-all");
  await page.locator("#review-search").fill("Bob");
  const checkboxes = page.locator("#session-review-list").getByRole("checkbox");
  await expect(checkboxes).toHaveCount(1);
  await checkboxes.first().check();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.locator("#review-search").fill("Alice");
  await expect(checkboxes).toHaveCount(2);
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#btn-delete-session-selected")).toHaveAccessibleName(
    "Remove 3 Selected",
  );
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "false");
  for (const checkbox of await checkboxes.all()) await expect(checkbox).not.toBeChecked();
  await expect(page.locator("#btn-delete-session-selected")).toHaveAccessibleName(
    "Remove 1 Selected",
  );
  await page.locator("#review-search").fill("Bob");
  await expect(checkboxes.first()).toBeChecked();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await button.click();
  await expect(checkboxes.first()).not.toBeChecked();
  expect(errors).toEqual([]);
});
