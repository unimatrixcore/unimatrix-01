import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pokerOcrContractSha256 } from "../src/contract.js";
import {
  ocrCategory,
  validateOcrText,
  validateReviewedLabel,
  pokerComboMultiplier,
  scorePokerInput,
  scorePokerCompletion,
  type PokerGameCompletion,
  type PokerGameScore,
} from "../src/index.js";

const state: PokerGameScore = {
  points: 0,
  combo: 0,
  maxCombo: 0,
  autoCompletes: 0,
  quickLabels: 0,
};
const completion: PokerGameCompletion = {
  persisted: true,
  valid: true,
  discard: false,
  elapsedMs: 999,
  label: "A",
  previousLabel: "",
  previouslyReviewed: false,
  previouslyDiscarded: false,
  usedAutoComplete: false,
  newUsername: false,
};

describe("current Poker Lab contract", () => {
  it("keeps the contract identity tied to its original bytes", () => {
    expect(
      createHash("sha256")
        .update(readFileSync(new URL("../ocr-contract.json", import.meta.url)))
        .digest("hex"),
    ).toBe(pokerOcrContractSha256);
  });
  it.each([
    ["name", "Player 1", true],
    ["name", "*RESERVED*", true],
    ["name", "Player 9", true],
    ["name", "Player 10", false],
    ["status", "Fold", true],
    ["status", "Hide Cards", true],
    ["status", "fold", false],
    ["bank", "G No Chips", true],
    ["bank", "S No Chips", true],
    ["bank", "No Chips", false],
    ["card", "10", true],
    ["card", "T", false],
    ["dealer", "D", true],
    ["dealer", "", true],
  ] as const)("keeps %s / %s behavior", (category, value, expected) => {
    expect(validateOcrText(category, value)).toBe(expected);
  });
  it("recognizes whole configured IDs and separates manual status transcription", () => {
    expect(ocrCategory("seats[8].cards[1]")).toBe("card");
    expect(ocrCategory("seat.0.name")).toBe("name");
    expect(ocrCategory("unrelated.name")).toBeNull();
    expect(ocrCategory("nameplate")).toBeNull();
    expect(ocrCategory("seat.0.name\n")).toBeNull();
    expect(validateOcrText("name", "Player 1\n")).toBe(false);
    expect(validateReviewedLabel("seat.0.status", "New Action")).toBeNull();
    expect(validateOcrText("status", "New Action")).toBe(false);
    expect(validateReviewedLabel("seat.0.status", "12")).toBeTypeOf("string");
    expect(validateReviewedLabel("seat.0.name", "Player 3")).toBeNull();
    expect(validateReviewedLabel("unknown", "")).toBeTypeOf("string");
  });
});

describe("original label game", () => {
  it("keeps combo boundaries and typing/tab/deletion rates", () => {
    expect([0, 4, 5, 9, 10, 19, 20].map(pokerComboMultiplier)).toEqual([1, 1, 2, 2, 3, 3, 5]);
    expect(scorePokerInput(state, "typing", 2).points).toBe(10);
    expect(scorePokerInput(state, "tab", 3).points).toBe(23);
    expect(scorePokerInput({ ...state, points: 100, combo: 5 }, "delete", 2).points).toBe(60);
    expect(scorePokerInput(state, "delete", 10).points).toBe(0);
    expect(scorePokerInput(state, "typing", 1, false)).toBe(state);
    expect(scorePokerInput(state, "typing", 0)).toBe(state);
    expect(() => scorePokerInput(state, "typing", -1)).toThrow();
  });
  it("awards only after successful persistence and preserves revisit behavior", () => {
    expect(scorePokerCompletion(state, { ...completion, persisted: false })).toBe(state);
    expect(scorePokerCompletion(state, completion)).toEqual({
      ...state,
      points: 100,
      combo: 1,
      maxCombo: 1,
      quickLabels: 1,
    });
    expect(scorePokerCompletion(state, { ...completion, usedAutoComplete: true })).toEqual({
      ...state,
      points: 60,
      combo: 1,
      maxCombo: 1,
      autoCompletes: 1,
    });
    expect(
      scorePokerCompletion(state, { ...completion, previousLabel: "A", previouslyReviewed: true }),
    ).toBe(state);
    expect(
      scorePokerCompletion(state, {
        ...completion,
        discard: true,
        previouslyDiscarded: true,
        label: null,
      }),
    ).toBe(state);
  });
  it("retains time boundaries, discard, discovery and correction rules", () => {
    expect(scorePokerCompletion(state, { ...completion, discard: true }).points).toBe(20);
    expect(scorePokerCompletion(state, { ...completion, discard: true, elapsedMs: 1000 })).toEqual({
      ...state,
      combo: 1,
      maxCombo: 1,
    });
    expect(
      scorePokerCompletion({ ...state, combo: 5 }, { ...completion, elapsedMs: 5000 }).combo,
    ).toBe(0);
    expect(
      scorePokerCompletion(
        { ...state, combo: 5 },
        { ...completion, discard: true, elapsedMs: 5000 },
      ).combo,
    ).toBe(0);
    expect(
      scorePokerCompletion({ ...state, combo: 5 }, { ...completion, valid: false }).combo,
    ).toBe(0);
    expect(
      scorePokerCompletion(state, { ...completion, label: "NewName", newUsername: true }),
    ).toEqual({ ...state, points: 150, combo: 1, quickLabels: 1 });
    expect(
      scorePokerCompletion(
        { ...state, points: 200, combo: 20 },
        { ...completion, previouslyReviewed: true, previousLabel: "K" },
      ),
    ).toEqual({ ...state, points: 200, combo: 1, maxCombo: 1, quickLabels: 1 });
    expect(() => scorePokerCompletion(state, { ...completion, elapsedMs: -1 })).toThrow();
  });
});
