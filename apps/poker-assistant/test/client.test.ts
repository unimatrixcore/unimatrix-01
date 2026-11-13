import { describe, expect, it } from "vitest";
import { invoke } from "../src/original/invoke.js";
import { pokerAssistantResponses } from "@unimatrix/shared";
describe("assistant native boundary", () => {
  it("rejects normal-browser calls and unknown commands", async () => {
    await expect(invoke("get_monitors")).rejects.toThrow("desktop window");
    await expect(invoke("unknown_command")).rejects.toThrow("Unknown assistant command");
  });
  it("rejects malformed production output before it reaches the display", () => {
    expect(
      pokerAssistantResponses.get_production_state.safeParse({ state: "available", game_state: {} })
        .success,
    ).toBe(false);
    expect(
      pokerAssistantResponses.capture_production_frame.safeParse({
        capture_id: "x",
        screenshot_bytes: [999],
      }).success,
    ).toBe(false);
  });
});
