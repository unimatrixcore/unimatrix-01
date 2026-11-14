import { expect, test } from "@playwright/test";
import { installLabFixture } from "./fixture.js";

function installSettingsFixture() {
  const previous = window.__POKER_LAB_TEST_INVOKE__;
  let model = "gpt-4.1";
  let activeId = "baseline",
    activationAttempts = 0;
  const activeRelease = () => ({
    configured: true,
    id: activeId,
    display_name: activeId === "baseline" ? "Original release" : "Version 5",
    general_sha256: (activeId === "baseline" ? "a" : "c").repeat(64),
    names_sha256: (activeId === "baseline" ? "b" : "d").repeat(64),
    path: "/private/models/runtime",
  });
  window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
    if (request.path === "/api/ai-review/config") {
      if (
        request.method === "POST" &&
        request.body &&
        typeof request.body === "object" &&
        "model" in request.body
      )
        model = String(request.body.model);
      return { status: 200, headers: {}, body: { configured: true, model } };
    }
    if (request.path === "/api/training/versions")
      return {
        status: 200,
        headers: {},
        body: {
          active_release: activeRelease(),
          versions: [
            {
              id: "baseline",
              display_name: "Original release",
              created_at: 0,
              active: activeId === "baseline",
              eligible: true,
              regressions: 0,
              improved: 0,
              benchmark: {
                exact_match: 0.98,
                cer: 0.02,
                p95_ms: 10,
                samples: 100,
                processing_errors: 0,
              },
            },
            {
              id: "candidate",
              display_name: "Version 5",
              created_at: 10,
              active: activeId === "candidate",
              eligible: true,
              regressions: 2,
              improved: 4,
              benchmark: {
                exact_match: 0.99,
                cer: 0.01,
                p95_ms: 10,
                samples: 100,
                baseline_exact_match: 0.98,
                processing_errors: 0,
              },
            },
          ],
        },
      };
    if (request.path === "/api/training/activate") {
      if (
        !request.body ||
        typeof request.body !== "object" ||
        !("acknowledge_regressions" in request.body) ||
        request.body.acknowledge_regressions !== true
      )
        return { status: 400, headers: {}, body: { error: "Regression acknowledgement missing" } };
      activationAttempts++;
      if (activationAttempts === 1)
        return { status: 500, headers: {}, body: { error: "Candidate failed to warm" } };
      activeId = "candidate";
      return { status: 200, headers: {}, body: { active_release: activeRelease() } };
    }
    return previous!(request);
  };
}

test.beforeEach(async ({ page }, info) => {
  if (info.title.startsWith("Settings preserves")) {
    await page.addInitScript({
      content: `(${installLabFixture.toString()})();(${installSettingsFixture.toString()})();`,
    });
  } else await page.addInitScript(installLabFixture);
});

test("Settings preserves the checkout footer and provides global configuration", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/collection");

  const settings = page.getByRole("button", { name: "Settings", exact: true });
  const wrapper = page.locator("[data-poker-settings-control]");
  await expect(settings).toHaveAttribute("title", "Settings");
  await expect(settings).toHaveText("");
  await expect(wrapper).toHaveClass("w-9");
  const collapsed = await settings.boundingBox();
  const rail = page.getByRole("navigation", { name: "Sections", exact: true });
  const firstLink = await rail.getByRole("link").first().boundingBox();
  expect(collapsed?.width).toBe(36);
  expect(collapsed?.height).toBe(36);
  expect(
    Math.abs(collapsed!.x + collapsed!.width / 2 - (firstLink!.x + firstLink!.width / 2)),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath("settings-footer-collapsed.png") });
  await settings.click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("details")).toHaveCount(0);
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveAttribute(
    "placeholder",
    "Saved key",
  );
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(dialog.getByText("a".repeat(12), { exact: true })).toHaveAttribute(
    "title",
    "a".repeat(64),
  );
  await expect(dialog).not.toContainText("/private/models/runtime");
  await dialog.getByLabel("Model", { exact: true }).fill("gpt-4.1-mini");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Saved");
  await expect(dialog.getByText("98.00% exact · 100 samples", { exact: true })).toBeVisible();
  const checkoutPicker = dialog.getByRole("combobox", { name: "Checkout", exact: true });
  const versionPicker = dialog.getByRole("combobox", { name: "Version", exact: true });
  const appearance = (element: HTMLElement | SVGElement) => {
    const style = getComputedStyle(element);
    return {
      height: style.height,
      border: style.borderTopWidth,
      borderColor: style.borderTopColor,
      radius: style.borderRadius,
      font: style.fontSize,
    };
  };
  expect(await checkoutPicker.evaluate(appearance)).toEqual(
    await versionPicker.evaluate(appearance),
  );
  await expect(checkoutPicker).toHaveAttribute("data-slot", "select-trigger");
  await expect(versionPicker).toHaveAttribute("data-slot", "select-trigger");
  await page.screenshot({ path: test.info().outputPath("settings-picker-consistency.png") });
  await expect(dialog.getByRole("button", { name: "Use version", exact: true })).toBeDisabled();
  await dialog.getByRole("combobox", { name: "Version", exact: true }).click();
  await page.getByRole("option", { name: "Version 5", exact: true }).click();
  await expect(
    dialog.getByText("2 regressions · 4 improvements vs original", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("99.00% exact · 100 samples", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Use version", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Candidate failed to warm");
  await expect(dialog.getByRole("button", { name: "Use version", exact: true })).toBeEnabled();
  await expect(dialog.getByText("a".repeat(12), { exact: true })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Version", exact: true })).toHaveText(
    "Version 5",
  );
  await page.screenshot({ path: test.info().outputPath("settings-activation-failed.png") });
  await dialog.getByRole("button", { name: "Use version", exact: true }).click();
  await expect(dialog.getByText("c".repeat(12), { exact: true })).toBeVisible();
  await expect(dialog.getByText("d".repeat(12), { exact: true })).toBeVisible();
  await expect(dialog.locator(".app-settings-release")).toHaveText("Version 5");
  await expect(dialog.getByRole("button", { name: "Use version", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("settings-version-active.png") });
  const selector = dialog.getByRole("combobox", { name: "Checkout", exact: true });
  await expect(selector).toHaveAttribute("title", "work/current");
  await selector.click();
  await expect(page.getByRole("option", { name: "Latest commit", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("option", { name: "work/other", exact: true }).click();
  await expect(selector).toHaveText("work/other");
  await expect(selector).toHaveAttribute("title", "work/current → work/other");
  await page.screenshot({ path: test.info().outputPath("settings-dialog.png") });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(settings).toBeFocused();
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Expand sections", exact: true }).click();
  await expect(settings).toHaveText("Settings");
  await expect(wrapper).toHaveClass("w-full min-w-0 pr-2");
  await expect(settings).toHaveClass(/w-full justify-start/);
  await expect
    .poll(async () =>
      settings.locator("span").evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  await page.screenshot({ path: test.info().outputPath("settings-footer-expanded.png") });
  await settings.click();
  await expect(dialog.getByLabel("Model", { exact: true })).toHaveValue("gpt-4.1-mini");
  await page.setViewportSize({ width: 420, height: 700 });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("width", "388px");
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(420);
  await page.screenshot({ path: test.info().outputPath("settings-dialog-narrow.png") });
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("preserves the poker chip, three-section rail, four-step workflow and recording controls", async ({
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
  await expect(rail.getByRole("link")).toHaveText(["OCR Data", "Gameplay", "OCR Training"]);
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
  await expect(page.locator("#dataset-catalog-label")).toHaveText("New fixture");
  await page.locator("#dataset-catalog-label").click();
  await expect(page.getByRole("menuitemradio", { name: "New fixture", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#collector-workspace")).toHaveClass(/ready/);
  await expect(page.locator("#nav-collection")).toBeVisible();
});

test("retains original Gameplay recording workspace and shared recording panel", async ({
  page,
}) => {
  await page.goto("/gameplay");
  await expect(page.locator(".gameplay-workspace")).toBeVisible();
  await expect(page.getByRole("region", { name: "Gameplay recording controls" })).toBeVisible();
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

test("review actions, shared selection and pointer-centered crop lens retain their behavior", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
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
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='60'%3E%3Crect width='40' height='60' fill='red'/%3E%3Crect x='40' width='40' height='60' fill='lime'/%3E%3Crect x='80' width='40' height='60' fill='blue'/%3E%3C/svg%3E",
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
    const grid = document.createElement("div");
    grid.id = "fixture-card-grid";
    grid.className = "capture-list grid";
    document.getElementById("collection-placeholder")?.before(grid);
    grid.append(card);
    for (const id of ["neighbor-one", "neighbor-two"]) {
      grid.append(
        createCard({
          id,
          imageSrc: card.querySelector("img")!.src,
          isSelected: false,
          onToggle: () => {},
          onEdit: () => {},
          onRemove: () => {},
          onSave: () => {},
        }),
      );
    }
    document.getElementById("collection-placeholder")?.classList.add("hidden");
    window.CollectorSharedUi.enhance(grid);
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
  const cardBounds = await card.boundingBox();
  const gridBounds = await page.locator("#fixture-card-grid").boundingBox();
  expect(cardBounds!.width).toBeLessThan(gridBounds!.width / 2);
  const region = await source.evaluate((img) => {
    const rect = img.getBoundingClientRect();
    const style = getComputedStyle(img);
    const px = (value: string) => Number.parseFloat(value) || 0;
    const left = px(style.paddingLeft) + px(style.borderLeftWidth);
    const top = px(style.paddingTop) + px(style.borderTopWidth);
    const width = rect.width - left - px(style.paddingRight) - px(style.borderRightWidth);
    const height = rect.height - top - px(style.paddingBottom) - px(style.borderBottomWidth);
    const source = img as HTMLImageElement;
    const scale = Math.min(width / source.naturalWidth, height / source.naturalHeight);
    const imageWidth = source.naturalWidth * scale;
    const imageHeight = source.naturalHeight * scale;
    return {
      left: rect.left + left + (width - imageWidth) / 2,
      top: rect.top + top + (height - imageHeight) / 2,
      width: imageWidth,
      height: imageHeight,
    };
  });
  const zoom = page.locator(".crop-zoom-preview");
  const zoomImage = zoom.locator("img");
  await page.mouse.move(region.left + region.width / 6, region.top + region.height / 2);
  await expect(zoom).toBeHidden();
  await page.keyboard.down("Shift");
  await expect(zoom).toBeVisible();
  await expect(zoomImage).toHaveCSS("image-rendering", "pixelated");
  const assertCenter = async (fraction: number) => {
    const sample = await zoomImage.evaluate((img) => {
      const rect = img.getBoundingClientRect();
      const lens = img.parentElement!.getBoundingClientRect();
      return {
        x: (lens.x + lens.width / 2 - rect.x) / rect.width,
        y: (lens.y + lens.height / 2 - rect.y) / rect.height,
        width: rect.width,
        height: rect.height,
      };
    });
    expect(sample.x).toBeCloseTo(
      (Math.trunc(region.left + region.width * fraction) - region.left) / region.width,
      4,
    );
    expect(sample.y).toBeCloseTo(0.5, 4);
    expect(sample.width).toBe(region.width * 2);
    expect(sample.height).toBe(region.height * 2);
    const lens = (await zoom.boundingBox())!;
    expect(lens.width).toBe(260);
    expect(lens.height).toBe(160);
    expect(lens.x).toBeGreaterThanOrEqual(8);
    expect(lens.y).toBeGreaterThanOrEqual(8);
    return imgTranslation();
  };
  const imgTranslation = () => zoomImage.evaluate((img) => img.style.left);
  const assertLensPixel = async (path: string, expected: number[]) => {
    const lens = (await zoom.boundingBox())!;
    const screenshot = await page.screenshot({ path });
    const pixel = await page.evaluate(
      async ({ base64, x, y }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return Array.from(context.getImageData(x, y, 1, 1).data);
      },
      {
        base64: screenshot.toString("base64"),
        x: Math.floor(lens.x + lens.width / 2),
        y: Math.floor(lens.y + lens.height / 2),
      },
    );
    expect(pixel).toEqual([...expected, 255]);
  };
  const first = await assertCenter(1 / 6);
  await assertLensPixel("../../.orchestration/evidence/pointer-magnifier-red.png", [255, 0, 0]);
  await page.mouse.move(region.left + (region.width * 5) / 6, region.top + region.height / 2);
  const second = await assertCenter(5 / 6);
  expect(second).not.toBe(first);
  await assertLensPixel("../../.orchestration/evidence/pointer-magnifier-blue.png", [0, 0, 255]);
  const sourceBox = (await source.boundingBox())!;
  await page.mouse.move(sourceBox.x + 5, sourceBox.y + 100);
  await expect(zoom).toBeHidden();
  await source.hover({ position: { x: 1, y: 1 } });
  await expect(zoom).toBeHidden();
  await page.mouse.move(region.left + region.width / 2, region.top + region.height / 2);
  await expect(zoom).toBeVisible();
  await page.keyboard.up("Shift");
  await expect(zoom).toBeHidden();
  await page.keyboard.down("Shift");
  await expect(zoom).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(zoom).toBeHidden();
  await page.keyboard.up("Shift");
  await page.keyboard.down("Shift");
  await expect(zoom).toBeVisible();
  await page.mouse.move(1, 1);
  await expect(zoom).toBeHidden();
  await page.keyboard.up("Shift");
  await page.setViewportSize({ width: 320, height: 240 });
  await source.evaluate((img) => {
    img.style.cssText =
      "position:fixed;right:2px;bottom:2px;z-index:4000;width:180px;height:90px;padding:0;border:0;object-fit:fill;max-width:none";
  });
  await source.hover({ position: { x: 179, y: 89 } });
  await page.keyboard.down("Shift");
  await expect(zoom).toBeVisible();
  const edge = (await zoom.boundingBox())!;
  expect(edge.x).toBeGreaterThanOrEqual(8);
  expect(edge.y).toBeGreaterThanOrEqual(8);
  expect(edge.x + edge.width).toBeLessThanOrEqual(312);
  expect(edge.y + edge.height).toBeLessThanOrEqual(232);
  await page.screenshot({
    path: "../../.orchestration/evidence/pointer-magnifier-viewport-edge.png",
  });
  await page.keyboard.up("Shift");
  await page.setViewportSize({ width: 1280, height: 720 });
  await source.evaluate((img) => {
    img.removeAttribute("style");
  });
  await page.evaluate(() => {
    document.getElementById("view-collection")?.classList.add("hidden");
    const review = document.getElementById("view-session-review");
    review?.classList.remove("hidden");
    review?.classList.add("active-view");
    for (const [id, text] of [
      ["btn-review-select-all", "Select shown"],
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
  await expect(page.locator("#btn-review-deselect-all")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove 1 Selected", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "AI review", exact: true })).toBeVisible();
  await expect(page.locator("#ai-review-button-progress")).toHaveText("Review complete");
  expect(errors).toEqual([]);
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

test("dataset controls remain reachable in the narrow toolbar", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 760 });
  await page.goto("/collection");
  await expect(page.locator("#loading-overlay")).toBeHidden();
  for (const name of [
    "Working dataset",
    "Create dataset",
    "Rename dataset",
    "Archive and restore datasets",
  ]) {
    const control = page.getByLabel(name, { exact: true }).locator("visible=true");
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(420);
  }
  await page.getByLabel("Working dataset", { exact: true }).locator("visible=true").click();
  const catalogBox = await page.locator(".dataset-dropdown").boundingBox();
  expect(catalogBox!.x).toBeGreaterThanOrEqual(0);
  expect(catalogBox!.x + catalogBox!.width).toBeLessThanOrEqual(420);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Rename dataset" }).click();
  await expect(page.locator("#dataset-name-input")).toBeVisible();
  await page.locator("#dataset-manager > summary").click();
  await page.getByLabel("Archive and restore datasets").click();
  await expect(page.locator("#dataset-action-title")).toHaveText("Manage datasets");
  await page.screenshot({ path: test.info().outputPath("narrow-dataset-controls.png") });
});
