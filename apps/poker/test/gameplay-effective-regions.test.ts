import { expect, it } from "vitest";
import {
  previewRegions,
  suspectedGameState,
  type GameplayPreviewFrame,
} from "../src/collector/gameplay_preview";

it("uses current profile geometry exclusively while preserving original capture evidence", () => {
  const original = {
    "seats[0].bet": {
      rect: { x: 1, y: 2, w: 3, h: 4 },
      prediction: { text: "old", schema_valid: true },
      error: null,
    },
  };
  const frame: GameplayPreviewFrame = {
    id: "frame",
    hand_id: "12",
    captured_at: "2026-11-13T00:00:00Z",
    image_url: "/frame.png",
    results: original,
    effective_config_snapshot: {
      region_profile_id: "current",
      regions: {
        viewport: { width: 1920, height: 1080 },
        legacy_seat_offset: 3,
        regions: [
          { id: "seat.3.bet", bounds: { x: 100, y: 200, width: 400, height: 40 } },
          {
            id: "board.0.suit",
            bounds: { x: 700, y: 400, width: 25, height: 30 },
            polygon: [
              { x: 700, y: 400 },
              { x: 725, y: 400 },
              { x: 725, y: 430 },
            ],
          },
        ],
      },
    },
    effective_results: {
      "seat.3.bet": {
        rect: { x: 999, y: 999, w: 1, h: 1 },
        prediction: { text: "355.6 BB", schema_valid: true },
        error: null,
      },
    },
  };
  const regions = previewRegions(frame, 1920, 1080);
  expect(regions).toHaveLength(2);
  expect(regions[0]).toMatchObject({ key: "seat.3.bet", rect: { x: 100, y: 200, w: 400, h: 40 } });
  expect(regions[1]?.polygon).toHaveLength(3);
  expect(previewRegions(frame, 1280, 720)).toEqual([]);
  expect(frame.results).toBe(original);
  expect(suspectedGameState(frame).seats[0]).toMatchObject({ index: 3, bet: "355.6 BB" });
  frame.effective_config_snapshot!.regions.regions[0]!.presence = {
    state: "absent",
    reason: "Supported source slot is empty",
    policy: "source_pixel_presence_v1",
  };
  expect(previewRegions(frame, 1920, 1080).map((r) => r.key)).toEqual(["board.0.suit"]);
  expect(frame.results).toBe(original);
});

it.each([false, true])("preserves reviewed blank suits with modern IDs: %s", (modern) => {
  const reading = (text: string) => ({
    rect: { x: 0, y: 0, w: 10, h: 10 },
    prediction: { text, schema_valid: true, review_state: "manual" },
    error: null,
  });
  const board = modern ? "board.0" : "community_cards[0]";
  const seat = modern ? "seat.0.card.0" : "seats[0].cards[0]";
  const frame: GameplayPreviewFrame = {
    id: "reviewed-blank",
    hand_id: null,
    captured_at: "2026-11-13T00:00:00Z",
    image_url: "/frame.png",
    effective_results: {
      [modern ? `${board}.rank` : board]: reading("A"),
      [`${board}.suit`]: reading(""),
      [modern ? `${seat}.rank` : seat]: reading("K"),
      [`${seat}.suit`]: reading(""),
    },
    color_state: {
      community_suits: ["h", "d"],
      seats: { "0": { in_play: true, hand_suits: ["h", "c"] } },
    },
  };
  const state = suspectedGameState(frame);
  expect(state.community[0]).toBe("A");
  expect(state.communitySuits.slice(0, 2)).toEqual([null, "d"]);
  expect(state.seats[0]?.cards[0]).toBe("K");
  expect(state.seats[0]?.suits).toEqual([null, "c"]);
  frame.effective_results![`${board}.suit`]!.prediction!.schema_valid = false;
  frame.effective_results![`${seat}.suit`]!.error = "Unavailable";
  expect(suspectedGameState(frame).communitySuits[0]).toBe("h");
  expect(suspectedGameState(frame).seats[0]?.suits[0]).toBe("h");
});
