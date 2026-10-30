import { describe, expect, it } from "vitest";
import { getUptimeTone, STATUS_DOT_CLASSES, STATUS_TEXT_CLASSES } from "../src/lib/status-tone.js";

describe("status tones", () => {
  it.each([
    [1, "ok"],
    [0.999, "ok"],
    [0.999 - Number.EPSILON, "warn"],
    [0.99, "warn"],
    [0.99 - Number.EPSILON, "bad"],
    [0, "bad"],
    [undefined, "idle"],
    [null, "idle"],
    [NaN, "idle"],
    [Infinity, "idle"],
    [-Infinity, "idle"],
    [-Number.EPSILON, "idle"],
    [1 + Number.EPSILON, "idle"],
  ] as const)("classifies %s as %s", (value, tone) => {
    expect(getUptimeTone(value)).toBe(tone);
  });
  it("provides matching dot and text vocabularies", () => {
    expect(Object.keys(STATUS_DOT_CLASSES)).toEqual(["ok", "warn", "bad", "idle"]);
    expect(Object.keys(STATUS_TEXT_CLASSES)).toEqual(Object.keys(STATUS_DOT_CLASSES));
  });
});
