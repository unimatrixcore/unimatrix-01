import { expect, test } from "@playwright/test";
import { installLabFixture } from "./fixture.js";

function installStatusFixture(malformed: boolean) {
  const previous = window.__POKER_LAB_TEST_INVOKE__!;
  const text = malformed ? "Away\nInjected" : "Away";
  const samples = [
    {
      id: "seats[1].status",
      sample_key: "away-current",
      label: "",
      base64_image: "",
      source: "Fixture table",
      image_url: "/status-crop.svg?label=Away",
      prediction: {
        id: "stale-away",
        text: "Away",
        raw_text: "Away",
        schema_valid: false,
        validation_contract: { sha256: "old-contract" },
      },
    },
    {
      id: "seats[2].status",
      sample_key: "next-status",
      label: "",
      base64_image: "",
      source: "Fixture table",
      image_url: "/status-crop.svg?label=Fold",
    },
  ];
  Object.assign(window, { statusReviews: [] as unknown[], statusSuggestions: [] as unknown[] });
  const success = (body: unknown) => ({ status: 200, headers: {}, body });
  window.__POKER_LAB_TEST_INVOKE__ = async (request) => {
    if (request.path === "/api/initial_data") {
      const response = (await previous(request)) as {
        status: number;
        headers: Record<string, string>;
        body: Record<string, unknown>;
      };
      return {
        ...response,
        body: {
          ...response.body,
          session: { frames: [], pool: samples, labelingUnlocked: true, currentReviewIdx: 0 },
        },
      };
    }
    if (request.path === "/api/model_suggestion") {
      const body = request.body as { sample_key: string };
      (window as unknown as { statusSuggestions: unknown[] }).statusSuggestions.push(body);
      const label = body.sample_key === "away-current" ? text : "Fold";
      return success({
        prediction: {
          id: "fresh-" + body.sample_key,
          text: label,
          raw_text: label,
          category: "status",
          schema_valid: body.sample_key !== "away-current" || !malformed,
        },
      });
    }
    if (request.path === "/api/review_label") {
      (window as unknown as { statusReviews: unknown[] }).statusReviews.push(request.body);
      return success({ success: true, event: { id: 1, schema_valid: 1, outside_contract: 0 } });
    }
    if (request.path === "/api/label_history") return success({ history: [], items: [] });
    return previous(request);
  };
}

for (const malformed of [false, true]) {
  test(
    malformed
      ? "Ctrl+Enter keeps malformed status suggestions blocked"
      : "Ctrl+Enter accepts fresh Away after refreshing a stale cached prediction",
    async ({ page }) => {
      await page.addInitScript({
        content: `(${installLabFixture.toString()})();(${installStatusFixture.toString()})(${malformed});`,
      });
      await page.route("**/status-crop.svg?**", (route) => {
        const label =
          new URL(route.request().url()).searchParams.get("label") === "Fold" ? "Fold" : "Away";
        return route.fulfill({
          contentType: "image/svg+xml",
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="48"><rect width="160" height="48" fill="#222"/><text x="10" y="30" fill="white">${label}</text></svg>`,
        });
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/labeling");
      await expect(page.locator("#collector-workspace")).toHaveClass(/ready/);
      await expect(page.locator("#view-labeling")).toBeVisible();
      await expect(page.locator("#label-input")).toHaveValue("");
      await expect(page.locator("#model-text")).toHaveText(malformed ? "Away\nInjected" : "Away");
      await expect(page.locator("#model-accept")).toBeEnabled({ enabled: !malformed });
      await expect
        .poll(() =>
          page.locator("#focus-img").evaluate((image: HTMLImageElement) => image.naturalWidth),
        )
        .toBeGreaterThan(0);
      if (!malformed) await page.screenshot({ path: test.info().outputPath("away-ready.png") });
      await page.locator("#label-input").focus();
      await page.keyboard.press("Control+Enter");
      if (malformed) {
        await expect(page.locator("#review-idx")).toHaveText("1");
        expect(
          await page.evaluate(
            () => (window as unknown as { statusReviews: unknown[] }).statusReviews,
          ),
        ).toEqual([]);
      } else {
        await expect
          .poll(() =>
            page.evaluate(
              () => (window as unknown as { statusReviews: unknown[] }).statusReviews.length,
            ),
          )
          .toBe(1);
        const receipt = await page.evaluate(
          () =>
            (window as unknown as { statusReviews: Record<string, unknown>[] }).statusReviews[0],
        );
        expect(receipt).toMatchObject({
          id: "seats[1].status",
          label: "Away",
          action: "accept",
          allow_outside_contract: false,
          prediction_id: "fresh-away-current",
        });
        await expect(page.locator("#review-idx")).toHaveText("2");
        await expect(page.locator("#model-text")).toHaveText("Fold");
        await expect
          .poll(() =>
            page.locator("#focus-img").evaluate((image: HTMLImageElement) => image.naturalWidth),
          )
          .toBeGreaterThan(0);
      }
      expect(errors).toEqual([]);
      await page.screenshot({
        path: test
          .info()
          .outputPath(malformed ? "malformed-status-blocked.png" : "away-accepted.png"),
      });
    },
  );
}
