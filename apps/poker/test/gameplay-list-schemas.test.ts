import { describe, expect, it } from "vitest";
import {
  pokerGameplayFrameSummarySchema,
  pokerGameplayHandSchema,
  pokerGameplaySessionSchema,
} from "@unimatrix/shared";

describe("Gameplay list boundaries", () => {
  it("accepts native summaries and rejects malformed row fields", () => {
    const session = {
      id: "s1",
      name: "Game",
      source: "monitor",
      interval_ms: 1000,
      status: "paused",
      created_at: "2026-01-01",
      frame_count: 1,
      hand_count: 1,
    };
    const hand = { hand_id: "h1", frame_count: 1, first_at: "2026-01-01", last_at: "2026-01-01" };
    const frame = {
      id: "f1",
      session_id: "s1",
      hand_id: "h1",
      captured_at: "2026-01-01",
      image_url: "/image",
      ocr_status: "complete",
      error: null,
    };
    expect(pokerGameplaySessionSchema.safeParse(session).success).toBe(true);
    expect(pokerGameplayHandSchema.safeParse(hand).success).toBe(true);
    expect(pokerGameplayFrameSummarySchema.safeParse(frame).success).toBe(true);
    expect(pokerGameplaySessionSchema.safeParse({ ...session, frame_count: -1 }).success).toBe(
      false,
    );
    expect(pokerGameplayHandSchema.safeParse({ ...hand, first_at: 1 }).success).toBe(false);
    expect(pokerGameplayFrameSummarySchema.safeParse({ ...frame, id: 5 }).success).toBe(false);
  });
});
