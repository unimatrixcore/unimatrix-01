import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { game } from "../test/fixtures.js";

test("preserves assistant controls, preference state, live reader and expiry", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    ({ state, pixels }) => {
      const colors = {
        card_text: "#ffffff",
        dim_text: "#aaaaaa",
        suits: { clubs: "#00aa00", diamonds: "#0000ff", hearts: "#ff0000", spades: "#ffffff" },
        dim_suits: { clubs: "#005500", diamonds: "#000055", hearts: "#550000", spades: "#aaaaaa" },
      };
      window.__ORIGINAL_ASSISTANT_TEST_INVOKE__ = (command) =>
        Promise.resolve(
          command === "get_monitors"
            ? [{ id: 1, name: "TEST-1", width: 1920, height: 1080, is_primary: true }]
            : command === "get_colors"
              ? colors
              : command === "capture_production_frame"
                ? { capture_id: "one", screenshot_bytes: pixels }
                : command === "extract_regions"
                  ? []
                  : command === "get_production_state"
                    ? {
                        state: "available",
                        reason: "",
                        capture_age_ms: 1,
                        frame_id: "one",
                        ocr_regions: {},
                        game_state: {
                          ...state,
                          seat_banks: {},
                          seat_statuses: {},
                          seat_dealers: {},
                          pot: "Pot: G 5 BB",
                          split_pot: null,
                        },
                      }
                    : command === "debug_env"
                      ? "Test environment"
                      : null,
        );
    },
    {
      state: game.state,
      pixels: Array.from(readFileSync(new URL("../src-tauri/icons/32x32.png", import.meta.url))),
    },
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Stake Poker Assistant" })).toBeVisible();
  await page.getByLabel("Your Stake Username:").fill("Player1");
  await page.getByLabel("Select Display Monitor:").selectOption("0");
  await page.getByRole("button", { name: "Hide Debug Overlay" }).click();
  await page.getByRole("button", { name: "Test Capture" }).click();
  await expect(page.getByText("#123456").first()).toBeVisible();
  await expect(page.getByText("Status: Waiting for a fresh read")).toBeVisible();
  await page.getByRole("button", { name: "Start Assistant" }).click();
  await page.getByRole("button", { name: "Stop Assistant" }).click();
  await expect(page.getByRole("button", { name: "Start Assistant" })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("a regular browser cannot issue native capture commands", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Open Poker Assistant in its desktop window/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Test Capture" })).toBeDisabled();
});
