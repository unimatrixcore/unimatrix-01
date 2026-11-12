import { expect, test } from "@playwright/test";
import { installLabFixture } from "./fixture.js";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installLabFixture);
});

test("work branch selector defaults to latest and preserves the active branch until replacement", async ({
  page,
}) => {
  await page.goto("/collection");
  const selector = page.getByRole("button", { name: "Work branch", exact: true });
  await expect(selector).toHaveAttribute("title", "work/current");
  await expect(selector).toHaveText("");
  await selector.click();
  await expect(
    page.getByRole("menuitemradio", { name: "Latest commit", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: "../../.orchestration/evidence/poker-branch-menu-collapsed.png" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Expand sections", exact: true }).click();
  await expect(selector).toHaveText("Latest commit");
  await selector.click();
  await page.screenshot({ path: "../../.orchestration/evidence/poker-branch-menu-expanded.png" });
  await page.getByRole("menuitemradio", { name: "work/other", exact: true }).click();
  await expect(selector).toHaveText("work/other");
  await expect(selector).toHaveAttribute("title", "work/current → work/other");
  await page.setViewportSize({ width: 760, height: 700 });
  await expect(selector).toBeVisible();
  await selector.click();
  await page.getByRole("menuitemradio", { name: "Latest commit", exact: true }).click();
  await expect(selector).toHaveText("Latest commit");
});

test("preserves the original poker chip, two-section rail, four-step workflow and recording controls", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/collection");
  await expect(page.locator("#collector-workspace")).toHaveClass(/ready/);
  await expect(page.locator("#loading-overlay")).not.toHaveClass(/active/);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    "href",
    "/static/ui/poker-chip.svg",
  );
  await expect(
    page.getByRole("navigation", { name: "Workflow", exact: true }).getByRole("button"),
  ).toHaveText(["Collection", "Labeling", "Review", "Database"]);
  await page.getByRole("button", { name: "Expand sections", exact: true }).click();
  const rail = page.getByRole("navigation", { name: "Sections", exact: true });
  await expect(rail.getByRole("link")).toHaveText(["OCR Data", "Gameplay"]);
  await expect(page.locator('img[src="/static/ui/poker-chip.svg"]').first()).toHaveAttribute(
    "src",
    "/static/ui/poker-chip.svg",
  );
  await page.getByRole("button", { name: "Collapse sections", exact: true }).click();
  await expect(page.getByText("No crops collected", { exact: true })).toBeVisible();
  await expect(page.locator("#capture-once")).toHaveText("Capture");
  await expect(page.locator("#watch-start")).toHaveText("Record");
  await page
    .getByRole("button", { name: "Capture source and recording settings", exact: true })
    .click();
  await expect(page.getByLabel("Capture source", { exact: true })).toHaveValue("TEST-1");
  await expect(page.locator("#watch-interval")).toHaveValue("2");
  await expect(page.getByText("Monitor or window", { exact: true })).toHaveCount(0);
  await expect(page.locator("#watch-settings-summary")).toHaveCount(0);
  await expect(page.locator(".watch-settings-panel .capture-settings-note")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Capture source and recording settings", exact: true }),
  ).toBeFocused();
  expect(errors).toEqual([]);
  await page.screenshot({
    path: test.info().outputPath("restored-collection.png"),
    fullPage: true,
  });
});

test("preserves dataset creation and source capture errors without adding navigation", async ({
  page,
}) => {
  await page.goto("/collection");
  await expect(page.locator("#collector-workspace")).toHaveClass(/ready/);
  await page.locator("#capture-once").click();
  await expect(page.getByText("NO GAME FOUND!", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create dataset", exact: true }).click();
  await page.locator("#dataset-name-input").fill("New fixture");
  await page.locator("#dataset-create").click();
  await expect(page.getByLabel("Working dataset", { exact: true })).toHaveValue("dataset-2");
  await expect(page.locator("#collector-workspace")).toHaveClass(/ready/);
  await expect(page.locator("#nav-collection")).toBeVisible();
});

test("retains original Gameplay recording workspace and shared recording panel", async ({
  page,
}) => {
  await page.goto("/gameplay");
  await expect(page.locator(".gameplay-workspace")).toBeVisible();
  await expect(page.locator(".recording-panel")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Capture source and recording settings", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#workflow-panel")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Capture source and recording settings", exact: true })
    .click();
  await expect(page.getByRole("combobox", { name: "Capture source", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Check every", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Recording name", exact: true })).toBeVisible();
  await expect(page.getByText("Monitor or window", { exact: true })).toHaveCount(0);
  await expect(page.locator(".capture-settings-note")).toHaveCount(0);
});

test("review actions, shared selection and enlarged crop preview retain their behavior", async ({
  page,
}) => {
  await page.goto("/collection");
  await expect(page.locator("#collector-workspace")).toHaveClass(/ready/);
  await page.evaluate(() => {
    let selected = false;
    const createCard = window.PokerLabList.createCard as unknown as (
      options: Record<string, unknown>,
    ) => HTMLElement;
    const card = createCard({
      id: "seat name",
      imageSrc:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='60'%3E%3Crect width='120' height='60' fill='red'/%3E%3C/svg%3E",
      isSelected: false,
      onToggle: () => {
        const input = document.querySelector<HTMLInputElement>(
          "#fixture-review-card .card-checkbox",
        );
        selected = !selected;
        if (input) input.checked = selected;
      },
      onEdit: () => {
        document.body.dataset.editClicked = "yes";
      },
      onRemove: () => {
        document.body.dataset.removeClicked = "yes";
      },
      onSave: () => {},
    });
    card.id = "fixture-review-card";
    document.getElementById("collection-placeholder")?.before(card);
    window.CollectorSharedUi.enhance(card);
  });
  const card = page.locator("#fixture-review-card");
  const checkbox = card.getByRole("checkbox", { name: "Select seat name crop" });
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toBeChecked();
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  const box = await checkbox.boundingBox();
  expect(box?.width).toBe(16);
  expect(box?.height).toBe(16);
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-edit-clicked", "yes");
  await card.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-remove-clicked", "yes");
  const source = card.locator("img");
  await source.hover();
  await page.keyboard.down("Shift");
  const zoom = page.locator(".crop-zoom-preview");
  await expect(zoom).toBeVisible();
  const imageSize = await source.evaluate((img) => {
    const rect = img.getBoundingClientRect();
    const source = img as HTMLImageElement;
    return Math.min(
      rect.width - 20,
      (rect.height - 20) * (source.naturalWidth / source.naturalHeight),
    );
  });
  const zoomSize = await zoom.boundingBox();
  expect(zoomSize!.width).toBeGreaterThan(imageSize * 1.8);
  expect(zoomSize!.x).toBeGreaterThanOrEqual(0);
  expect(zoomSize!.y).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: "../../.orchestration/evidence/poker-review-controls.png" });
  await page.keyboard.up("Shift");
  await expect(zoom).toBeHidden();
  await page.evaluate(() => {
    document.getElementById("view-collection")?.classList.add("hidden");
    const review = document.getElementById("view-session-review");
    review?.classList.remove("hidden");
    review?.classList.add("active-view");
    for (const [id, text] of [
      ["btn-review-select-all", "Select shown"],
      ["btn-review-deselect-all", "Deselect 1"],
      ["btn-delete-session-selected", "Remove 1 Selected"],
      ["btn-add-db", "Save all 1,917 crops"],
    ] as const) {
      const button = document.getElementById(id);
      if (button) {
        button.classList.remove("hidden");
        button.textContent = text;
      }
    }
    document.getElementById("btn-ai-review")?.classList.remove("hidden");
    const progress = document.getElementById("ai-review-button-progress");
    if (progress) {
      progress.classList.remove("hidden");
      progress.textContent = "Review complete";
    }
  });
  const save = page.getByRole("button", { name: "Save all 1,917 crops", exact: true });
  await expect(save).toHaveAttribute("title", "Save all 1,917 crops");
  await expect(save).toHaveCSS("font-size", "0px");
  await expect(page.getByRole("button", { name: "Select shown", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deselect 1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove 1 Selected", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "AI review", exact: true })).toBeVisible();
  await expect(page.locator("#ai-review-button-progress")).toHaveText("Review complete");
  await page.screenshot({
    path: "../../.orchestration/evidence/poker-review-toolbar.png",
    fullPage: true,
  });
});

test("gameplay shows detected suits and hides only color-confirmed inactive seats", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.__POKER_LAB_TEST_INVOKE__!;
    const session = {
      id: "fixture-session",
      name: "Fixture",
      source: "TEST-1",
      interval_ms: 1000,
      status: "stopped",
      created_at: "2026-11-12T00:00:00Z",
      frame_count: 1,
      hand_count: 1,
    };
    const reading = (text: string) => ({
      rect: { x: 1, y: 1, w: 2, h: 2 },
      prediction: { text, schema_valid: true },
      error: null,
    });
    const frame = {
      id: "fixture-frame",
      session_id: session.id,
      hand_id: "123",
      captured_at: session.created_at,
      image_url:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='50'/%3E",
      width: 100,
      height: 50,
      config_snapshot: { regions: { seats: [{}, {}, {}] } },
      results: { "community_cards[0]": reading("A"), "seats[0].cards[0]": reading("K") },
      color_state: {
        seats: {
          "0": { in_play: true, hand_suits: ["h", null] },
          "1": { in_play: false, hand_suits: [] },
          "2": { in_play: null, hand_suits: [] },
        },
        community_suits: ["s"],
        configuration: "recorded",
      },
    };
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      const success = (body: unknown) => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body,
      });
      if (request.path === "/api/gameplay") return success({ sessions: [session] });
      if (request.path === "/api/gameplay/sessions/fixture-session")
        return success({ session, hands: [] });
      if (request.path === "/api/gameplay/sessions/fixture-session/frames")
        return success({ frames: [frame], total: 1 });
      if (request.path === "/api/gameplay/frames/fixture-frame") return success({ frame });
      return original(request);
    };
  });
  await page.goto("/gameplay");
  await expect(page.getByLabel("Community card 1: A♠")).toBeVisible();
  await expect(page.getByLabel("Seat 1 card 1: K♥")).toBeVisible();
  await expect(page.getByText("Seat 2", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Seat 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "1 inactive seat" }).click();
  await expect(page.getByText("Seat 2", { exact: true })).toBeVisible();
  await page.screenshot({ path: "../../.orchestration/evidence/poker-gameplay-color-fixture.png" });
});
