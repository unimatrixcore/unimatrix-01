import { expect, test, type Page } from "@playwright/test";
import { installLabFixture } from "./fixture.js";

async function installFixtureWith(page: Page, setup: (argument: string) => void, argument = "") {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${setup.toString()})(${JSON.stringify(argument)});`,
  });
}

test.beforeEach(async ({ page }) => {
  await page.route(/\/api\/db_image\/|\/toolbar-crop\.svg/, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="50"><text x="8" y="32" fill="white">Pot: G 10 BB</text></svg>',
    }),
  );
});

async function assertAccent(page: Page, step: string) {
  const button = page.locator(`#nav-${step}`);
  await expect(button).toHaveAttribute("aria-current", "step");
  await expect(page.locator('.stepper [aria-current="step"]')).toHaveCount(1);
  await expect
    .poll(() =>
      button.evaluate((node) => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--primary)";
        probe.style.color = "var(--primary-foreground)";
        node.append(probe);
        const actual = getComputedStyle(node);
        const expected = getComputedStyle(probe);
        const result = [
          actual.backgroundColor === expected.backgroundColor,
          actual.color === expected.color,
          actual.opacity,
          actual.boxShadow,
          actual.backgroundImage,
        ];
        probe.remove();
        return result;
      }),
    )
    .toEqual([true, true, "1", "none", "none"]);
}

for (const step of ["collection", "labeling", "session-review", "database"]) {
  test(`${step} current workflow uses computed accent, including disabled state`, async ({
    page,
  }) => {
    await installFixtureWith(
      page,
      (step) => {
        const previous = window.__POKER_LAB_TEST_INVOKE__!;
        const sample = {
          id: "pot",
          sample_key: "toolbar-pot",
          label: "Pot: G 10 BB",
          reviewed: true,
          base64_image: "",
          image_url: "/toolbar-crop.svg",
        };
        const summary = { total: 1, pending: 0, reviewed: 1, captures: 1, revision: 1 };
        window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
          if (request.path === "/api/model_suggestion")
            return { status: 200, headers: {}, body: { available: false, state: "unavailable" } };
          const response = (await previous(request)) as {
            status: number;
            headers: Record<string, string>;
            body: Record<string, unknown>;
          };
          if (request.path === "/api/initial_data" && step !== "collection")
            response.body = {
              ...response.body,
              session: {
                frames: [],
                pool: [sample],
                labelingUnlocked: step === "labeling",
                reviewUnlocked: step === "session-review",
              },
            };
          if (
            request.query.background_page === "1" &&
            ["/api/db_entries", "/api/queue/review/items"].includes(request.path)
          )
            response.body = {
              items:
                request.path === "/api/db_entries"
                  ? [{ filename: "pot.png", id: "pot", label: "Pot: G 10 BB" }]
                  : [sample],
              nextCursor: null,
              hasMore: false,
              total: 1,
              meta: { summary },
            };
          return response;
        };
      },
      step,
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(step === "session-review" ? "/review" : `/${step}`);
    await expect(page.locator("#collector-workspace")).toHaveClass(/ready/);
    await expect(page.locator("#nav-step-prev, #nav-step-next")).toHaveCount(0);
    await assertAccent(page, step);
    await expect(page.locator(`#view-${step}`)).toBeVisible();
    await page.locator(`#nav-${step}`).focus();
    await assertAccent(page, step);
    await page.locator(`#nav-${step}`).evaluate((node: HTMLButtonElement) => {
      node.disabled = true;
    });
    await assertAccent(page, step);
    await page.screenshot({ path: test.info().outputPath(`${step}-accent.png`) });
    expect(errors).toEqual([]);
  });
}

test("Database exposes shared dataset controls and stays on Database after switching", async ({
  page,
}) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.path === "/api/datasets" && request.query.background_page === "1") {
          return {
            status: 200,
            headers: {},
            body: {
              items: [
                { id: "fixture", name: "First dataset", archived: false },
                { id: "second", name: "Second dataset", archived: false },
              ],
              nextCursor: null,
              hasMore: false,
              total: 2,
              meta: { default_dataset_id: "fixture" },
            },
          };
        }
        if (request.path === "/api/db_entries" && request.query.background_page === "1") {
          const second = request.headers["x-dataset-id"] === "second";
          return {
            status: 200,
            headers: {},
            body: {
              items: [
                {
                  id: "seats[0].name",
                  filename: "player.png",
                  label: second ? "Second player" : "First player",
                },
              ],
              nextCursor: null,
              hasMore: false,
              total: 1,
              meta: {},
            },
          };
        }
        return previous(request);
      };
    }).toString()})();`,
  });
  await page.goto("/database");
  await expect(page.locator("#loading-overlay")).toBeHidden();
  const picker = page.getByRole("button", { name: "Working dataset", exact: true });
  await expect(picker).toBeVisible();
  await expect(picker).toHaveAttribute("data-slot", "dropdown-menu-trigger");
  await expect(page.getByRole("button", { name: "Create dataset", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rename dataset", exact: true })).toBeVisible();
  await expect(page.getByLabel("Archive and restore datasets", { exact: true })).toBeVisible();
  await expect(page.locator("#db-list")).toContainText("First player");
  await picker.click();
  await page.getByRole("menuitemradio", { name: "Second dataset", exact: true }).click();
  await expect(picker).toHaveText("Second dataset");
  await expect(page.locator("#db-list")).toContainText("Second player");
  await expect(page.locator("#view-database")).toBeVisible();
  await expect(page).toHaveURL(/\/database$/);
  await assertAccent(page, "database");
  await page.setViewportSize({ width: 420, height: 760 });
  await expect(picker).toBeInViewport();
  const bounds = await page.locator("#dataset-tools").boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(420);
});

test("shared dataset dropdown preserves keyboard selection and create, rename, archive, restore", async ({
  page,
}) => {
  await page.addInitScript(installLabFixture);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/collection");
  await expect(page.locator("#collector-workspace")).toHaveClass(/ready/);
  const trigger = page.getByRole("button", { name: "Working dataset", exact: true });
  await expect(trigger).toHaveAttribute("data-slot", "dropdown-menu-trigger");
  await expect(page.locator("details#dataset-catalog")).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator('[data-slot="dropdown-menu-content"].dataset-dropdown')).toBeVisible();
  await page.keyboard.press("End");
  const archived = page.getByRole("menuitemradio", { name: "Archived fixture · Restore" });
  await expect(archived).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole("menuitemradio", { name: "Archived fixture", exact: true }).click();
  await expect(trigger).toHaveText("Archived fixture");
  await page.getByRole("button", { name: "Create dataset", exact: true }).click();
  await page.locator("#dataset-name-input").fill("Toolbar dataset");
  await page.locator("#dataset-create").click();
  await expect(trigger).toHaveText("Toolbar dataset");
  await page.getByRole("button", { name: "Rename dataset", exact: true }).click();
  await page.locator("#dataset-name-input").fill("Renamed toolbar dataset");
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveText("Renamed toolbar dataset");
  await page.getByLabel("Archive and restore datasets", { exact: true }).click();
  await page.locator("#dataset-remove").click();
  await page.locator("#btn-modal-confirm").click();
  await expect(trigger).not.toHaveText("Renamed toolbar dataset");
  await page.keyboard.press("Escape");
  await trigger.click();
  await page
    .getByRole("menuitemradio", { name: "Renamed toolbar dataset · Restore", exact: true })
    .click();
  await trigger.click();
  await expect(
    page.getByRole("menuitemradio", { name: "Renamed toolbar dataset", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  expect(errors).toEqual([]);
});

test("long catalog eagerly loads with bounded shared rows and keyboard reaches its end at narrow width", async ({
  page,
}) => {
  await installFixtureWith(page, () => {
    const previous = window.__POKER_LAB_TEST_INVOKE__!;
    const items = Array.from({ length: 1200 }, (_, index) => ({
      id: index === 0 ? "fixture" : `dataset-${index}`,
      name: `Dataset ${String(index).padStart(4, "0")}`,
      archived: false,
    }));
    Object.assign(window, { toolbarDatasetPages: [] as number[] });
    window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
      if (request.path === "/api/datasets" && request.query.background_page === "1") {
        const offset = Number(request.query.cursor || 0);
        const end = Math.min(items.length, offset + Number(request.query.limit || 250));
        (window as unknown as { toolbarDatasetPages: number[] }).toolbarDatasetPages.push(end);
        return {
          status: 200,
          headers: {},
          body: {
            items: items.slice(offset, end),
            nextCursor: end < items.length ? String(end) : null,
            hasMore: end < items.length,
            total: items.length,
            meta: { default_dataset_id: "fixture" },
          },
        };
      }
      return previous(request);
    };
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.setViewportSize({ width: 420, height: 760 });
  await page.goto("/collection");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { toolbarDatasetPages: number[] }).toolbarDatasetPages.includes(1200),
      ),
    )
    .toBe(true);
  const trigger = page.getByRole("button", { name: "Working dataset", exact: true });
  await expect(
    page.locator("#dataset-tools [data-slot=native-select-wrapper]").first(),
  ).toBeHidden();
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await expect(
    page.getByRole("menuitemradio", { name: "Dataset 1199", exact: true }),
  ).toBeFocused();
  expect(await page.getByRole("menuitemradio").count()).toBeLessThan(30);
  const box = await page.locator(".dataset-dropdown").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(420);
  await page.screenshot({ path: test.info().outputPath("narrow-long-dataset-menu.png") });
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveText("Dataset 1199");
  expect(errors).toEqual([]);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.keyboard.press("Home");
  await expect(
    page.getByRole("menuitemradio", { name: "Dataset 0000", exact: true }),
  ).toBeFocused();
  await page.keyboard.type("Dataset 0800");
  await expect(
    page.getByRole("menuitemradio", { name: "Dataset 0800", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("Database failure does not block recovered Review startup", async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.path === "/api/db_entries") throw new Error("Database temporarily unavailable");
        const response = (await previous(request)) as { body: Record<string, unknown> };
        if (request.path === "/api/initial_data") {
          response.body = {
            ...response.body,
            session: {
              frames: [],
              pool: [
                {
                  id: "pot",
                  sample_key: "recovered",
                  label: "G 10",
                  reviewed: true,
                  base64_image: "",
                  image_url: "/toolbar-crop.svg",
                },
              ],
              reviewUnlocked: true,
              labelingUnlocked: true,
            },
          };
        }
        return response;
      };
    }).toString()})();`,
  });
  await page.goto("/collection");
  await expect(page.locator("#collector-workspace")).toHaveClass(/ready/);
  await expect(page.locator("#loading-overlay")).toBeHidden();
  await assertAccent(page, "session-review");
  await expect(page.locator("#view-session-review .card").first()).toBeVisible();
  await expect(page.locator("#nav-collection")).toBeDisabled();
  await expect(page).toHaveURL(/\/review$/);
});

for (const path of ["/collection", "/review"]) {
  test(`persisted Review locks select Review before first reveal from ${path} and reload`, async ({
    page,
  }) => {
    await installFixtureWith(page, () => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      const sample = {
        id: "pot",
        sample_key: "locked-review-pot",
        label: "Pot: G 10 BB",
        reviewed: true,
        base64_image: "",
        image_url: "/toolbar-crop.svg",
      };
      const summary = { total: 1, pending: 0, reviewed: 1, captures: 1, revision: 1 };
      Object.assign(window, { toolbarProgress: [] as unknown[] });
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.path === "/api/save_session_progress")
          (window as unknown as { toolbarProgress: unknown[] }).toolbarProgress.push(request.body);
        if (request.path === "/api/model_suggestion")
          return { status: 200, headers: {}, body: { available: false, state: "unavailable" } };
        const response = (await previous(request)) as {
          status: number;
          headers: Record<string, string>;
          body: Record<string, unknown>;
        };
        if (request.path === "/api/initial_data")
          response.body = {
            ...response.body,
            session: {
              queue_mode: "paged",
              queue_summary: summary,
              review_batch: { mode: "stream", batch_id: "locked-review", next_cursor: null },
              review_stats: { total: 1, pending: 0 },
              frames: [],
              pool: [sample],
              labelingUnlocked: true,
              reviewUnlocked: true,
              currentReviewIdx: 0,
              queueLastCommitReceipt: "preserved-receipt",
            },
          };
        if (
          request.query.background_page === "1" &&
          ["/api/db_entries", "/api/queue/review/items"].includes(request.path)
        )
          response.body = {
            items:
              request.path === "/api/db_entries"
                ? [{ filename: "pot.png", id: "pot", label: "Pot: G 10 BB" }]
                : [sample],
            nextCursor: null,
            hasMore: false,
            total: 1,
            meta: { summary },
          };
        return response;
      };
      const reveals: unknown[] = [];
      Object.assign(window, { toolbarReveals: reveals });
      new MutationObserver(() => {
        const overlay = document.getElementById("loading-overlay");
        const workspace = document.getElementById("collector-workspace");
        if (
          !overlay ||
          overlay.classList.contains("active") ||
          !workspace?.classList.contains("ready")
        )
          return;
        if (reveals.length) return;
        reveals.push({
          active: document.querySelector('.stepper [aria-current="step"]')?.id,
          collectionDisabled: (document.getElementById("nav-collection") as HTMLButtonElement)
            .disabled,
          labelingDisabled: (document.getElementById("nav-labeling") as HTMLButtonElement).disabled,
          view: document.querySelector(".view.active-view")?.id,
        });
      }).observe(document, {
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
      });
    });
    await page.goto(path);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await page.reload();
      await expect(page.locator("#loading-overlay")).toBeHidden();
      await assertAccent(page, "session-review");
      await expect(page.locator("#nav-collection")).toBeDisabled();
      await expect(page.locator("#nav-labeling")).toBeDisabled();
      await expect
        .poll(() =>
          page.evaluate(() => (window as unknown as { toolbarReveals: unknown[] }).toolbarReveals),
        )
        .toEqual([
          {
            active: "nav-session-review",
            collectionDisabled: true,
            labelingDisabled: true,
            view: "view-session-review",
          },
        ]);
      await expect(page).toHaveURL(/\/review$/);
      await expect
        .poll(() =>
          page.evaluate(() =>
            (window as unknown as { toolbarProgress: unknown[] }).toolbarProgress.at(-1),
          ),
        )
        .toMatchObject({
          reviewUnlocked: true,
          labelingUnlocked: true,
          queueLastCommitReceipt: "preserved-receipt",
        });
      await page.locator("#nav-collection").evaluate((button: HTMLButtonElement) => {
        button.click();
      });
      await assertAccent(page, "session-review");
    }
    await page.screenshot({ path: test.info().outputPath("review-first-reveal.png") });
    await page.locator("#nav-database").click();
    await assertAccent(page, "database");
    await page.goBack();
    await assertAccent(page, "session-review");
  });
}
