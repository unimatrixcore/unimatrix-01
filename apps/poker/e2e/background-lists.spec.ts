import { expect, test } from "@playwright/test";
import { installLabFixture } from "./fixture.js";

function installNavigationRegressionFixture() {
  const previous = window.__POKER_LAB_TEST_INVOKE__!;
  const summary = { total: 2, pending: 2, reviewed: 0, captures: 1, revision: 1 };
  const crops = [1, 2].map((n) => ({
    id: "seat.0.name",
    sample_key: `pending-${n}`,
    queue_id: n,
    base64_image: "",
    label: "",
    reviewed: false,
  }));
  const entries = [
    { filename: "alice.png", id: "seat.0.name", label: "Alice" },
    { filename: "bob.png", id: "seat.0.name", label: "Bob" },
  ];
  const writes: Array<{ filename: string; label: string }> = [];
  Object.assign(window, { navigationReviewWrites: writes });
  const success = (body: unknown) => ({ status: 200, headers: {}, body });
  const page = (items: unknown[], meta: unknown = {}) =>
    success({ items, nextCursor: null, hasMore: false, total: items.length, meta });
  window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
    if (request.path === "/api/initial_data") {
      const response = (await previous(request)) as { body: Record<string, unknown> };
      return {
        ...response,
        body: {
          ...response.body,
          session: {
            queue_mode: "paged",
            pool: crops,
            frames: [],
            queue_summary: summary,
            review_batch: { mode: "stream", batch_id: "navigation-run", next_cursor: null },
            review_stats: { total: 2, pending: 2, items: 0, time: 0 },
            labelingUnlocked: true,
          },
          collection_page: { items: crops, next_cursor: null, summary },
        },
      };
    }
    if (request.query.background_page === "1") {
      if (request.path === "/api/queue") return page(crops, { summary });
      if (request.path === "/api/db_entries") {
        const search = (request.query.search || "").toLowerCase();
        return page(entries.filter((entry) => entry.label.toLowerCase().includes(search)));
      }
      if (request.path === "/api/label_history") return page([]);
    }
    if (request.path === "/api/model_suggestion")
      return success({ available: false, state: "unavailable" });
    if (request.path === "/api/review_label") {
      const body = request.body as { filename: string; label: string };
      writes.push({ filename: body.filename, label: body.label });
      const entry = entries.find((item) => item.filename === body.filename);
      if (entry) entry.label = body.label;
      return success({ success: true, event: { id: writes.length }, summary });
    }
    return previous(request);
  };
}

for (const destination of ["collection", "database"]) {
  test(`${destination} remounts after repeated labeling round trips`, async ({ page }) => {
    await page.addInitScript(installLabFixture);
    await page.addInitScript(installNavigationRegressionFixture);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/collection");
    const cards = page.locator(
      destination === "collection" ? "#frame-list .card" : "#db-list .card",
    );
    if (destination === "database") await page.locator("#nav-database").click();
    await expect(cards.first()).toBeVisible();
    for (let round = 0; round < 2; round++) {
      await page.locator("#nav-labeling").click();
      await expect(page.locator("#label-input")).toBeVisible();
      await page.locator(destination === "collection" ? "#nav-step-prev" : "#nav-database").click();
      await expect(cards.first()).toBeVisible();
      await expect(cards).toHaveCount(2);
    }
    expect(errors).toEqual([]);
  });
}

test("individual database selections retain metadata across search changes", async ({ page }) => {
  await page.addInitScript(installLabFixture);
  await page.addInitScript(installNavigationRegressionFixture);
  await page.goto("/collection");
  await page.locator("#nav-database").click();
  await page.locator("#db-search").fill("Alice");
  const alice = page.locator('#db-list .card[data-filename="alice.png"]');
  await expect(alice).toBeVisible();
  await alice.getByRole("checkbox").click();
  await page.locator("#db-search").fill("Bob");
  const bob = page.locator('#db-list .card[data-filename="bob.png"]');
  await expect(bob).toBeVisible();
  await bob.getByRole("checkbox").click();
  await expect(page.locator("#btn-db-deselect-all")).toContainText("2");
  await page.locator("#db-bulk-label-input").fill("Charlie");
  await page.locator("#btn-db-bulk-label").click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { navigationReviewWrites: unknown[] }).navigationReviewWrites,
      ),
    )
    .toEqual([
      { filename: "alice.png", label: "Charlie" },
      { filename: "bob.png", label: "Charlie" },
    ]);
});

test("collection uses the native page bridge and windows eager-loaded crops", async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      const summary = { total: 400, pending: 400, reviewed: 0, captures: 1, revision: 1 };
      const calls: string[] = [];
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      Object.assign(window, { fixtureListCalls: calls, releaseFixturePage: () => release?.() });
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.query.background_page === "1" && request.path === "/api/datasets")
          return {
            status: 200,
            headers: {},
            body: {
              items: [
                { id: "fixture", name: "Fixture dataset", archived: false },
                { id: "archived", name: "Archived fixture", archived: true },
              ],
              nextCursor: null,
              hasMore: false,
              total: 2,
              meta: { default_dataset_id: "fixture" },
            },
          };
        if (
          request.query.background_page === "1" &&
          ["/api/name_suggestions", "/api/db_entries"].includes(request.path)
        )
          return {
            status: 200,
            headers: {},
            body: { items: [], nextCursor: null, hasMore: false, total: 0, meta: {} },
          };
        if (request.path === "/api/initial_data") {
          const response = (await previous(request)) as { body: Record<string, unknown> };
          return {
            ...response,
            body: {
              ...response.body,
              session: { queue_mode: "paged", frames: [], pool: [], queue_summary: summary },
              collection_page: { items: [], next_cursor: null, summary },
            },
          };
        }
        if (request.path === "/api/queue" && request.query.background_page === "1") {
          const cursor = Number(request.query.cursor || 0);
          calls.push(String(cursor));
          if (cursor === 100) await gate;
          const items = Array.from({ length: 100 }, (_, i) => ({
            id: "pot",
            queue_id: cursor + i + 1,
            sample_key: `sample-${cursor + i}`,
            base64_image: "",
            reviewed: false,
          }));
          return {
            status: 200,
            headers: {},
            body: {
              items,
              nextCursor: cursor < 300 ? String(cursor + 100) : null,
              hasMore: cursor < 300,
              total: 400,
              meta: { summary },
            },
          };
        }
        return previous(request);
      };
    }).toString()})();`,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") console.log("CONSOLE", message.text());
  });
  await page.goto("/collection");
  await expect(page.locator("#collector-workspace")).toHaveClass(/ready/);
  await expect(page.locator("#frame-list .collection-crop-card").first()).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { fixtureListCalls: string[] }).fixtureListCalls.length,
      ),
    )
    .toBeGreaterThan(1);
  await page.evaluate(() => {
    (window as unknown as { releaseFixturePage: () => void }).releaseFixturePage();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { fixtureListCalls: string[] }).fixtureListCalls.length,
      ),
    )
    .toBeGreaterThan(1);
  expect(await page.locator("#frame-list .collection-crop-card").count()).toBeLessThan(100);
  await expect(page.locator("#collection-pagination")).toBeHidden();
  await expect(page.locator("#frame-list")).not.toContainText(/\d+\s*[–-]\s*\d+\s+of\s+\d+/);
  expect(errors).toEqual([]);
});

test("full review loads the run through the shared bridge with filters and no page controls", async ({
  page,
}) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      const calls: string[] = [];
      const historyCalls: string[] = [];
      Object.assign(window, { fixtureReviewCalls: calls, fixtureHistoryCalls: historyCalls });
      const summary = { total: 300, pending: 0, reviewed: 300, captures: 1, revision: 1 };
      const sample = (n: number) => ({
        id: "pot",
        queue_id: n + 1,
        sample_key: `sample-${n}`,
        base64_image: "",
        label: "G 10",
        reviewed: true,
        discarded: false,
      });
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.query.background_page === "1" && request.path === "/api/datasets")
          return {
            status: 200,
            headers: {},
            body: {
              items: [
                { id: "fixture", name: "Fixture dataset", archived: false },
                { id: "archived", name: "Archived fixture", archived: true },
              ],
              nextCursor: null,
              hasMore: false,
              total: 2,
              meta: { default_dataset_id: "fixture" },
            },
          };
        if (
          request.query.background_page === "1" &&
          ["/api/name_suggestions", "/api/db_entries"].includes(request.path)
        )
          return {
            status: 200,
            headers: {},
            body: { items: [], nextCursor: null, hasMore: false, total: 0, meta: {} },
          };
        if (
          request.query.background_page === "1" &&
          request.path === "/api/label_history" &&
          (("filename" in request.query && !request.query.filename) ||
            ("sample_key" in request.query && !request.query.sample_key))
        )
          return { status: 400, headers: {}, body: { error: "Empty history selector" } };
        if (request.query.background_page === "1" && request.path === "/api/label_history") {
          const offset = Number(request.query.cursor || 0),
            limit = Number(request.query.limit || 250),
            end = Math.min(600, offset + limit);
          historyCalls.push(`label:${offset}`);
          return {
            status: 200,
            headers: {},
            body: {
              items: Array.from({ length: end - offset }, (_, i) => ({
                kind: (offset + i) % 2 ? "prediction" : "event",
                payload: {
                  id: offset + i,
                  created_at: "2026-01-01",
                  action: "correct",
                  label: `Label ${offset + i}`,
                  text: `Prediction ${offset + i}`,
                },
              })),
              nextCursor: end < 600 ? String(end) : null,
              hasMore: end < 600,
              total: 600,
              meta: {},
            },
          };
        }
        if (request.query.background_page === "1" && request.path === "/api/get_session_history") {
          historyCalls.push(`scores:${request.query.order}:${request.query.limit}`);
          return {
            status: 200,
            headers: {},
            body: {
              items: [{ score: 9999, items: 10, rpm: 5, timestamp: 1 }],
              nextCursor: "more",
              hasMore: true,
              total: 2100,
              meta: {},
            },
          };
        }
        if (request.path === "/api/initial_data") {
          const response = (await previous(request)) as { body: Record<string, unknown> };
          return {
            ...response,
            body: {
              ...response.body,
              session: {
                queue_mode: "paged",
                frames: [],
                pool: [sample(0)],
                queue_summary: summary,
                review_batch: { mode: "stream", batch_id: "run-1", next_cursor: null },
                review_stats: { total: 300, pending: 0 },
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
          const cursor = Number(request.query.cursor || 0);
          if (request.path.includes("review"))
            calls.push(`${request.query.run_id}:${request.query.search || ""}:${cursor}`);
          return {
            status: 200,
            headers: {},
            body: {
              items: Array.from({ length: 100 }, (_, i) => sample(cursor + i)),
              nextCursor: cursor < 200 ? String(cursor + 100) : null,
              hasMore: cursor < 200,
              total: 300,
              meta: { summary, review_stats: { total: 300, pending: 0 } },
            },
          };
        }
        return previous(request);
      };
    }).toString()})();`,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") console.log("CONSOLE", message.text());
  });
  await page.goto("/collection");
  await expect(page.locator("#nav-session-review")).toBeEnabled();
  await page.locator("#nav-session-review").hover();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { fixtureReviewCalls: string[] }).fixtureReviewCalls.length,
      ),
    )
    .toBeGreaterThan(0);
  await page.locator("#nav-session-review").click();
  await expect(page.locator("#session-review-list .card").first()).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { fixtureReviewCalls: string[] }).fixtureReviewCalls.length,
      ),
    )
    .toBeGreaterThan(1);
  expect(await page.locator("#session-review-list .card").count()).toBeLessThan(100);
  await expect(page.locator(".review-page-bar")).toBeHidden();
  await expect(page.locator(".review-page-footer")).toBeHidden();
  const card = page.locator("#session-review-list .card").first();
  await card.getByText("Review history", { exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { fixtureHistoryCalls: string[] }).fixtureHistoryCalls.filter((x) =>
            x.startsWith("label:"),
          ).length,
      ),
    )
    .toBeGreaterThan(2);
  await expect(card.locator(".card-history")).toContainText("Label 0");
  const highest = await page.evaluate(() =>
    window.CollectorBackgroundLists.historySummary("fixture", null, null, false),
  );
  expect(highest[0]?.score).toBe(9999);
  expect(
    await page.evaluate(() =>
      (window as unknown as { fixtureHistoryCalls: string[] }).fixtureHistoryCalls.some(
        (x) => x === "scores:score:5",
      ),
    ),
  ).toBe(true);

  await card.getByRole("checkbox").check();
  await expect(card.getByRole("checkbox")).toBeChecked();
  await card.getByRole("button", { name: "Edit" }).click();
  const input = page.getByRole("combobox", { name: "Label for pot" }).first();
  await expect(input).toBeFocused();
  await input.fill("G 42");
  await expect(input).toHaveValue("G 42");
  await page.locator("#review-search").fill("pot");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { fixtureReviewCalls: string[] }).fixtureReviewCalls.some((value) =>
          value.startsWith("run-1:pot:"),
        ),
      ),
    )
    .toBe(true);
  expect(errors).toEqual([]);
});

test("database selects all matching records beyond the background limit", async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      const calls: string[] = [];
      const batches: number[] = [];
      Object.assign(window, { databaseCalls: calls, databaseBatches: batches });
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.query.background_page === "1" && request.path === "/api/datasets")
          return {
            status: 200,
            headers: {},
            body: {
              items: [
                { id: "fixture", name: "Fixture dataset", archived: false },
                { id: "second", name: "Second dataset", archived: false },
              ],
              nextCursor: null,
              hasMore: false,
              total: 2,
              meta: { default_dataset_id: "fixture" },
            },
          };
        if (request.query.background_page === "1" && request.path === "/api/name_suggestions")
          return {
            status: 200,
            headers: {},
            body: {
              items: [{ name: "SavedPlayer" }],
              nextCursor: null,
              hasMore: false,
              total: 1,
              meta: {},
            },
          };
        if (request.query.background_page === "1" && request.path === "/api/db_entries") {
          const offset = Number(request.query.cursor || 0),
            limit = Number(request.query.limit || 250),
            total = 2100;
          calls.push(`${request.headers["x-dataset-id"]}:${request.query.search || ""}:${offset}`);
          const end = Math.min(total, offset + limit),
            items = Array.from({ length: end - offset }, (_, i) => ({
              id: "pot",
              label: "G 10",
              filename: `item-${offset + i}.png`,
            }));
          return {
            status: 200,
            headers: {},
            body: {
              items,
              nextCursor: end < total ? String(end) : null,
              hasMore: end < total,
              total,
              meta: {},
            },
          };
        }
        if (request.path === "/api/db_delete" && request.method === "POST") {
          batches.push((request.body as { filenames: string[] }).filenames.length);
          return { status: 200, headers: {}, body: { message: "Removed" } };
        }
        return previous(request);
      };
    }).toString()})();`,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  await page.goto("/collection");
  await expect(page.locator("#nav-database")).toBeEnabled();
  await page.locator("#nav-database").click();
  await expect(page.locator("#db-list .card").first()).toBeVisible();
  await expect(page.locator("#db-pagination")).toBeHidden();
  expect(await page.locator("#db-list .card").count()).toBeLessThan(100);
  await page.locator("#db-search").fill("pot");
  await page.locator("#btn-db-select-all").click();
  await expect(page.locator("#btn-db-deselect-all")).toContainText("2100", { timeout: 15000 });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { databaseCalls: string[] }).databaseCalls.some((x) =>
          x.endsWith(":2000"),
        ),
      ),
    )
    .toBe(true);
  await page.locator("#btn-delete-db-selected").click();
  await page.locator("#btn-modal-confirm").click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { databaseBatches: number[] }).databaseBatches.length,
      ),
    )
    .toBe(21);
  expect(
    await page.evaluate(() =>
      Math.max(...(window as unknown as { databaseBatches: number[] }).databaseBatches),
    ),
  ).toBeLessThanOrEqual(100);
  await page.locator("#nav-collection").click();
  await page.locator("#dataset-catalog-label").click();
  await page.getByRole("button", { name: "Second dataset" }).click();
  await expect(page.locator("#dataset-catalog-label")).toHaveText("Second dataset");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { databaseCalls: string[] }).databaseCalls.some((x) =>
          x.startsWith("second:"),
        ),
      ),
    )
    .toBe(true);
  expect(errors).toEqual([]);
});

test("saved names are available to labeling autocomplete", async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.query.background_page === "1" && request.path === "/api/datasets")
          return {
            status: 200,
            headers: {},
            body: {
              items: [{ id: "fixture", name: "Fixture dataset", archived: false }],
              nextCursor: null,
              hasMore: false,
              total: 1,
              meta: { default_dataset_id: "fixture" },
            },
          };
        if (request.query.background_page === "1" && request.path === "/api/name_suggestions")
          return {
            status: 200,
            headers: {},
            body: {
              items: [{ name: "SavedPlayer" }],
              nextCursor: null,
              hasMore: false,
              total: 1,
              meta: {},
            },
          };
        if (
          request.query.background_page === "1" &&
          ["/api/queue", "/api/db_entries"].includes(request.path)
        )
          return {
            status: 200,
            headers: {},
            body: { items: [], nextCursor: null, hasMore: false, total: 0, meta: {} },
          };
        if (request.path === "/api/initial_data") {
          const response = (await previous(request)) as { body: Record<string, unknown> };
          return {
            ...response,
            body: {
              ...response.body,
              session: {
                queue_mode: "paged",
                frames: [],
                pool: [
                  {
                    id: "seat.0.name",
                    sample_key: "name-1",
                    queue_id: 1,
                    base64_image: "",
                    label: "",
                    reviewed: false,
                  },
                ],
                queue_summary: { total: 1, pending: 1, reviewed: 0, captures: 1, revision: 1 },
                review_batch: { mode: "stream", batch_id: "run", next_cursor: null },
                labelingUnlocked: true,
              },
              collection_page: {
                items: [],
                next_cursor: null,
                summary: { total: 1, pending: 1, reviewed: 0, captures: 1, revision: 1 },
              },
            },
          };
        }
        return previous(request);
      };
    }).toString()})();`,
  });
  await page.goto("/labeling");
  const input = page.locator("#label-input");
  await expect(input).toBeVisible();
  await input.fill("Saved");
  await expect(page.locator("#ghost-text")).toContainText("Player");
});

test("catalog creates, renames, archives and restores a dataset", async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      const entries = [
        { id: "fixture", name: "Fixture dataset", archived: false },
        { id: "second", name: "Second dataset", archived: false },
      ];
      const success = (body: unknown) => ({ status: 200, headers: {}, body });
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.path === "/api/datasets" && request.query.background_page === "1")
          return success({
            items: entries,
            nextCursor: null,
            hasMore: false,
            total: entries.length,
            meta: { default_dataset_id: "fixture" },
          });
        if (
          request.query.background_page === "1" &&
          ["/api/name_suggestions", "/api/db_entries", "/api/queue"].includes(request.path)
        )
          return success({ items: [], nextCursor: null, hasMore: false, total: 0, meta: {} });
        if (request.path === "/api/datasets" && request.method === "POST") {
          const item = {
            id: "created",
            name: (request.body as { name: string }).name,
            archived: false,
          };
          entries.push(item);
          return success({ dataset: item });
        }
        if (
          request.path.startsWith("/api/datasets/") &&
          ["PATCH", "DELETE"].includes(request.method)
        ) {
          const item = entries.find((x) => x.id === request.path.split("/").at(-1));
          if (item) {
            if (request.method === "DELETE") item.archived = true;
            else Object.assign(item, request.body);
          }
          return success({ success: true });
        }
        return previous(request);
      };
    }).toString()})();`,
  });
  await page.goto("/collection");
  await page.locator("#dataset-create-open").click();
  await page.locator("#dataset-name-input").fill("New dataset");
  await page.locator("#dataset-create").click();
  await expect(page.locator("#dataset-catalog-label")).toHaveText("New dataset");
  await page.locator("#dataset-rename-open").click();
  await page.locator("#dataset-name-input").fill("Renamed dataset");
  await page.locator("#dataset-rename").click();
  await expect(page.locator("#dataset-catalog-label")).toHaveText("Renamed dataset");
  await page.locator("#dataset-manager summary").click();
  await page.locator("#dataset-remove").click();
  await page.locator("#btn-modal-confirm").click();
  await expect(page.locator("#dataset-catalog-label")).not.toHaveText("Renamed dataset");
  await page.locator("#dataset-catalog-label").click();
  await page.getByRole("button", { name: "Renamed dataset · Restore" }).click();
  await expect(page.getByText("Dataset restored.")).toBeVisible();
});

test("late name suggestions cannot cross a dataset switch", async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      let release: (() => void) | undefined;
      const delayed = new Promise<void>((resolve) => {
        release = resolve;
      });
      Object.assign(window, { releaseOldNames: () => release?.() });
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.query.background_page === "1" && request.path === "/api/datasets")
          return {
            status: 200,
            headers: {},
            body: {
              items: [
                { id: "fixture", name: "Fixture dataset", archived: false },
                { id: "second", name: "Second dataset", archived: false },
              ],
              nextCursor: null,
              hasMore: false,
              total: 2,
              meta: { default_dataset_id: "fixture" },
            },
          };
        if (request.query.background_page === "1" && request.path === "/api/name_suggestions") {
          const old = request.headers["x-dataset-id"] === "fixture";
          if (old) await delayed;
          return {
            status: 200,
            headers: {},
            body: {
              items: [{ name: old ? "StalePlayer" : "StablePlayer" }],
              nextCursor: null,
              hasMore: false,
              total: 1,
              meta: {},
            },
          };
        }
        if (
          request.query.background_page === "1" &&
          ["/api/db_entries", "/api/queue"].includes(request.path)
        )
          return {
            status: 200,
            headers: {},
            body: { items: [], nextCursor: null, hasMore: false, total: 0, meta: {} },
          };
        if (request.path === "/api/initial_data") {
          const response = (await previous(request)) as { body: Record<string, unknown> };
          return {
            ...response,
            body: {
              ...response.body,
              session: {
                queue_mode: "paged",
                frames: [],
                pool: [
                  {
                    id: "seat.0.name",
                    sample_key: "name-1",
                    queue_id: 1,
                    base64_image: "",
                    label: "",
                    reviewed: false,
                  },
                ],
                queue_summary: { total: 1, pending: 1, reviewed: 0, captures: 1, revision: 1 },
                review_batch: { mode: "stream", batch_id: "run", next_cursor: null },
                labelingUnlocked: true,
              },
              collection_page: {
                items: [],
                next_cursor: null,
                summary: { total: 1, pending: 1, reviewed: 0, captures: 1, revision: 1 },
              },
            },
          };
        }
        return previous(request);
      };
    }).toString()})();`,
  });
  await page.goto("/collection");
  await page.locator("#dataset-catalog-label").click();
  await page.getByRole("button", { name: "Second dataset" }).click();
  await expect(page.locator("#dataset-catalog-label")).toHaveText("Second dataset");
  await page.evaluate(() => {
    (window as unknown as { releaseOldNames: () => void }).releaseOldNames();
  });
  await page.locator("#nav-labeling").click();
  const input = page.locator("#label-input");
  await expect(input).toBeVisible();
  await input.fill("Sta");
  await expect(page.locator("#ghost-text")).toContainText("blePlayer");
  await input.press("Tab");
  await expect(input).toHaveValue("StablePlayer");
});

test("restores a remembered dataset beyond the first catalog page", async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      localStorage.setItem("ocr:active-dataset", "dataset-1099");
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.path === "/api/datasets" && request.query.background_page === "1") {
          const offset = Number(request.query.cursor || 0),
            limit = Number(request.query.limit || 250),
            end = Math.min(1100, offset + limit);
          return {
            status: 200,
            headers: {},
            body: {
              items: Array.from({ length: end - offset }, (_, i) => ({
                id: `dataset-${offset + i}`,
                name: `Dataset ${offset + i}`,
                archived: false,
              })),
              nextCursor: end < 1100 ? String(end) : null,
              hasMore: end < 1100,
              total: 1100,
              meta: { default_dataset_id: "dataset-0" },
            },
          };
        }
        if (
          request.query.background_page === "1" &&
          ["/api/name_suggestions", "/api/db_entries", "/api/queue"].includes(request.path)
        )
          return {
            status: 200,
            headers: {},
            body: { items: [], nextCursor: null, hasMore: false, total: 0, meta: {} },
          };
        return previous(request);
      };
    }).toString()})();`,
  });
  await page.goto("/collection");
  await expect(page.locator("#dataset-catalog-label")).toHaveText("Dataset 1099");
  await page.locator("#dataset-catalog-label").click();
  await expect(page.locator(".dataset-catalog-row").first()).toBeVisible();
  expect(await page.locator(".dataset-catalog-row").count()).toBeLessThan(100);
});

test("rail prefetch survives the full navigation and is consumed once", async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.query.background_page === "1" && request.path === "/api/gameplay") {
          sessionStorage.setItem(
            "gamePageRequests",
            String(Number(sessionStorage.getItem("gamePageRequests") || 0) + 1),
          );
          return {
            status: 200,
            headers: {},
            body: {
              items: [
                {
                  id: "game-1",
                  name: "Fixture game",
                  source: "TEST-1",
                  interval_ms: 2000,
                  status: "stopped",
                  created_at: "2026-01-01T00:00:00Z",
                  frame_count: 0,
                  hand_count: 0,
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
  await page.goto("/collection");
  const link = page.getByRole("link", { name: "Gameplay" });
  await link.hover();
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("poker-lab:first-page:v1")))
    .not.toBeNull();
  await link.click();
  await expect(page).toHaveURL(/\/gameplay$/);
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("gamePageRequests")))
    .toBe("1");
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("poker-lab:first-page:v1")))
    .toBeNull();
});

test("OCR rail prefetch is scoped to the selected dataset across navigation", async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      localStorage.setItem("ocr:active-dataset", "fixture");
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.query.background_page === "1" && request.path === "/api/queue") {
          sessionStorage.setItem(
            "queuePageRequests",
            String(Number(sessionStorage.getItem("queuePageRequests") || 0) + 1),
          );
          return {
            status: 200,
            headers: {},
            body: {
              items: [
                { id: "pot", queue_id: 1, sample_key: "one", base64_image: "", reviewed: false },
              ],
              nextCursor: null,
              hasMore: false,
              total: 1,
              meta: { summary: { total: 1, pending: 1, reviewed: 0, captures: 1, revision: 1 } },
            },
          };
        }
        return previous(request);
      };
    }).toString()})();`,
  });
  await page.goto("/gameplay");
  const link = page.getByRole("link", { name: "OCR Data" });
  await link.hover();
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("poker-lab:first-page:v1")))
    .not.toBeNull();
  await link.click();
  await expect(page).toHaveURL(/\/collection$/);
  await expect(page.locator("#frame-list .collection-crop-card").first()).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("queuePageRequests")))
    .toBe("1");
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("poker-lab:first-page:v1")))
    .toBeNull();
});

test("stale database continuation retries from the first page", async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!,
        calls: string[] = [];
      let rejected = false;
      Object.assign(window, { staleDatabaseCalls: calls });
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.query.background_page === "1" && request.path === "/api/db_entries") {
          const cursor = request.query.cursor || "0";
          calls.push(cursor);
          if (cursor !== "0" && !rejected) {
            rejected = true;
            return { status: 409, headers: {}, body: { error: "stale" } };
          }
          const start = Number(cursor),
            end = Math.min(200, start + 100);
          return {
            status: 200,
            headers: {},
            body: {
              items: Array.from({ length: end - start }, (_, i) => ({
                id: "pot",
                label: "G 1",
                filename: `entry-${start + i}`,
              })),
              nextCursor: end < 200 ? String(end) : null,
              hasMore: end < 200,
              total: 200,
              meta: {},
            },
          };
        }
        return previous(request);
      };
    }).toString()})();`,
  });
  await page.goto("/collection");
  await page.locator("#nav-database").click();
  const retry = page.locator("#db-list").getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { staleDatabaseCalls: string[] }).staleDatabaseCalls.join(","),
      ),
    )
    .toMatch(/^0,100,0/);
});

test("capture presentation waits for committed virtual Collection cards", async ({ page }) => {
  await page.addInitScript({
    content: `(${installLabFixture.toString()})(); (${(() => {
      const previous = window.__POKER_LAB_TEST_INVOKE__!;
      let captured = false;
      const item = {
        id: "pot",
        queue_id: 1,
        sample_key: "new-crop",
        base64_image: "",
        source: "frame.png",
        rect: { x: 0, y: 0, w: 1, h: 1 },
        reviewed: false,
      };
      window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
        if (request.path === "/api/capture" && request.method === "POST") {
          captured = true;
          return {
            status: 200,
            headers: {},
            body: {
              id: "frame",
              source: "frame.png",
              frame_width: 1,
              frame_height: 1,
              regions: [item],
              summary: { total: 1, pending: 1, reviewed: 0, captures: 1, revision: 1 },
            },
          };
        }
        if (request.path === "/api/queue" && request.query.background_page === "1")
          return {
            status: 200,
            headers: {},
            body: {
              items: captured ? [item] : [],
              nextCursor: null,
              hasMore: false,
              total: captured ? 1 : 0,
              meta: {
                summary: {
                  total: captured ? 1 : 0,
                  pending: captured ? 1 : 0,
                  reviewed: 0,
                  captures: captured ? 1 : 0,
                  revision: captured ? 1 : 0,
                },
              },
            },
          };
        return previous(request);
      };
    }).toString()})();`,
  });
  await page.goto("/collection");
  await expect(page.locator("#collector-workspace")).toHaveClass(/ready/);
  await page.evaluate(() => {
    const animation = (
      window as unknown as {
        CollectorCaptureAnimation: {
          present: (options: {
            prepareTargets: () => Promise<Array<{ element: HTMLElement }>>;
          }) => Promise<unknown>;
        };
      }
    ).CollectorCaptureAnimation;
    Object.assign(window, {
      CollectorCaptureAnimation: {
        ...animation,
        present: async (options: {
          prepareTargets: () => Promise<Array<{ element: HTMLElement }>>;
        }) => {
          const targets = await options.prepareTargets();
          Object.assign(window, { captureTargetReady: !!targets[0]?.element.isConnected });
          return { shown: true };
        },
      },
    });
  });
  await page.locator("#capture-once").click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { captureTargetReady?: boolean }).captureTargetReady,
      ),
    )
    .toBe(true);
  await expect(page.locator('#frame-list [data-sample-key="new-crop"]')).toBeVisible();
});
