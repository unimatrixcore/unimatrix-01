import { expect, it } from "vitest";
import { pokerGameplayReadingVerificationSchema } from "@unimatrix/shared";
import { gameplayErrorMessage } from "../src/collector/gameplay-errors";

it("keeps schema diagnostics out of the Gameplay error banner", () => {
  const result = pokerGameplayReadingVerificationSchema.safeParse({
    state: "unexpected",
    source: "capture",
  });
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(gameplayErrorMessage(result.error)).toBe("Unable to load Gameplay data.");
    expect(gameplayErrorMessage(result.error, "Unable to load review data.")).toBe(
      "Unable to load review data.",
    );
  }
});

it("retains concise actionable failures", () => {
  expect(gameplayErrorMessage(new Error("ChatGPT authentication failed"))).toBe(
    "ChatGPT authentication failed",
  );
});

it("summarizes unstructured or oversized failures", () => {
  expect(gameplayErrorMessage({ invalid: "response" })).toBe("Unable to load Gameplay data.");
  expect(gameplayErrorMessage(new Error("x".repeat(240)))).toBe("Unable to load Gameplay data.");
});
