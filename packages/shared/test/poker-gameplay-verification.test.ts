import { describe, expect, it } from "vitest";
import { pokerGameplayFrameSummarySchema } from "../src/schemas/poker-gameplay-lists";

const frame = {
  id: "frame",
  session_id: "recording",
  hand_id: "89612872",
  captured_at: "2026-11-13T00:00:00Z",
  image_url: "/frame.png",
  ocr_status: "complete",
  error: null,
  effective_results: {
    "seats[0].bet": {
      rect: { x: 100, y: 200, w: 90, h: 30 },
      prediction: null,
      verification: { state: "absent", source: "capture" },
    },
    "community_cards[0]": {
      rect: { x: 760, y: 400, w: 30, h: 35 },
      prediction: { text: "Q" },
      verification: { state: "pending", source: "capture" },
    },
    "seats[0].nameplate": {
      rect: { x: 200, y: 300, w: 150, h: 55 },
      prediction: null,
      verification: { state: "visual_indicator", source: "none" },
    },
  },
  verification: {
    region_profile_id: "profile",
    status: "unverified",
    total: 1,
    verified: 0,
    unverified: 1,
    needs_review: 0,
    unsupported: 0,
    absent_count: 1,
  },
};

describe("Gameplay verification responses", () => {
  it("accepts absent OCR readings alongside pending readings and visual indicators", () => {
    const result = pokerGameplayFrameSummarySchema.parse(frame);
    expect(result.effective_results?.["seats[0].bet"]?.verification?.state).toBe("absent");
    expect(result.effective_results?.["community_cards[0]"]?.verification?.state).toBe("pending");
    expect(result.effective_results?.["seats[0].nameplate"]?.verification?.state).toBe(
      "visual_indicator",
    );
    expect(result.verification?.absent_count).toBe(1);
  });

  it("still rejects unknown verification states", () => {
    const invalid = structuredClone(frame);
    invalid.effective_results["seats[0].bet"].verification.state = "unexpected";
    expect(pokerGameplayFrameSummarySchema.safeParse(invalid).success).toBe(false);
  });
});
