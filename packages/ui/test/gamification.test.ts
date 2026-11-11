import { describe, expect, it } from "vitest";
import {
  awardSample,
  classifyReviewReward,
  createAwardLedger,
  createReadClock,
  pauseReadClock,
  resumeReadClock,
  readClockElapsedMs,
  snapshotReadClock,
  restoreReadClock,
  restoreAwardLedger,
  snapshotAwardLedger,
  restoreSampleAward,
} from "../src/lib/gamification.js";

const saved = {
  sampleId: "lesson:1",
  action: "save" as const,
  label: "answer",
  suggestionText: "draft",
};

describe("award ledger", () => {
  it("classifies configurable rewards including explicit blanks and no event", () => {
    expect(classifyReviewReward({ ...saved, action: "accept" })).toBe(10);
    expect(classifyReviewReward(saved)).toBe(20);
    expect(classifyReviewReward({ ...saved, suggestionText: null })).toBe(15);
    expect(classifyReviewReward({ ...saved, label: "", suggestionText: "" })).toBe(10);
    expect(classifyReviewReward({ ...saved, label: "", suggestionText: "draft" })).toBe(20);
    expect(classifyReviewReward({ ...saved, action: null })).toBe(0);
    expect(
      classifyReviewReward(saved, { acceptedPoints: 1, correctedPoints: 3, manualPoints: 2 }),
    ).toBe(3);
  });
  it("awards each caller-scoped key once without mutating prior state", () => {
    const original = createAwardLedger();
    const first = awardSample(original, saved);
    expect(first).toMatchObject({
      awarded: true,
      pointsAwarded: 20,
      ledger: { points: 20, streak: 1 },
    });
    expect(original).toEqual({ points: 0, streak: 0, awardedSampleIds: [] });
    expect(Object.isFrozen(first.ledger)).toBe(true);
    expect(Object.isFrozen(first.ledger.awardedSampleIds)).toBe(true);
    expect(awardSample(first.ledger, { ...saved, label: "new" })).toEqual({
      ledger: first.ledger,
      awarded: false,
      pointsAwarded: 0,
    });
    expect(awardSample(first.ledger, { ...saved, sampleId: "other-session:1" }).ledger.points).toBe(
      40,
    );
  });
  it("does not reward absent events or previously reviewed items", () => {
    const ledger = createAwardLedger();
    expect(awardSample(ledger, { ...saved, action: null }).ledger).toBe(ledger);
    const reviewed = awardSample(ledger, { ...saved, previouslyReviewed: true });
    expect(reviewed).toMatchObject({
      awarded: false,
      pointsAwarded: 0,
      ledger: { points: 0, streak: 0 },
    });
    expect(awardSample(reviewed.ledger, saved).awarded).toBe(false);
  });
  it("recovers an award receipt exactly once through JSON persistence", () => {
    const first = restoreSampleAward(createAwardLedger(), { sampleId: "lesson:1", points: 7 });
    const recovered = restoreAwardLedger(
      JSON.parse(JSON.stringify(snapshotAwardLedger(first.ledger))),
    );
    expect(restoreSampleAward(recovered, { sampleId: "lesson:1", points: 7 })).toMatchObject({
      awarded: false,
      pointsAwarded: 0,
      ledger: { points: 7, streak: 1 },
    });
    expect(restoreSampleAward(recovered, { sampleId: "lesson:2", points: 0 }).ledger.streak).toBe(
      2,
    );
  });
  it.each([NaN, Infinity, -1, Number.MAX_VALUE])(
    "rejects unsafe persisted/reward values %s",
    (value) => {
      expect(() =>
        restoreAwardLedger({ points: value, streak: 0, awardedSampleIds: [] }),
      ).toThrow();
      expect(() =>
        restoreSampleAward(createAwardLedger(), { sampleId: "a", points: value }),
      ).toThrow();
      expect(() =>
        classifyReviewReward(saved, { acceptedPoints: 0, correctedPoints: value, manualPoints: 0 }),
      ).toThrow();
    },
  );
  it("rejects malformed ledger IDs and fractional streaks", () => {
    expect(() => restoreAwardLedger({ points: 0, streak: 1.2, awardedSampleIds: [] })).toThrow();
    expect(() => restoreAwardLedger({ points: 0, streak: 0, awardedSampleIds: [""] })).toThrow();
    expect(() => restoreAwardLedger(null)).toThrow();
  });
});

describe("read clock", () => {
  it("counts only reading and resumes only after every pause reason clears", () => {
    const start = createReadClock(100);
    const editing = pauseReadClock(start, "editing", 1100);
    const loading = pauseReadClock(editing, "loading", 2100);
    const paused = pauseReadClock(loading, "paused", 3100);
    const loadDone = resumeReadClock(paused, "loading", 4100);
    const pauseOff = resumeReadClock(loadDone, "paused", 5100);
    expect(readClockElapsedMs(pauseOff, 6100)).toBe(1000);
    expect(pauseOff.pauseReasons).toEqual(["editing"]);
    const resumed = resumeReadClock(pauseOff, "editing", 7100);
    expect(readClockElapsedMs(resumed, 8100)).toBe(2000);
    expect(start).toEqual({ elapsedMs: 0, startedAtMs: 100, pauseReasons: [] });
  });
  it("keeps recovered editing frozen and excludes time away", () => {
    const frozen = pauseReadClock(createReadClock(0), "editing", 1000);
    const recovered = restoreReadClock(
      JSON.parse(JSON.stringify(snapshotReadClock(frozen, 5000))),
      100000,
    );
    expect(readClockElapsedMs(recovered, 200000)).toBe(1000);
    expect(resumeReadClock(recovered, "loading", 200000)).toBe(recovered);
    expect(readClockElapsedMs(resumeReadClock(recovered, "editing", 200000), 201000)).toBe(2000);
    const active = restoreReadClock(snapshotReadClock(createReadClock(0), 1000), 100000);
    expect(readClockElapsedMs(active, 101000)).toBe(2000);
  });
  it("handles repeated pauses, idle, and backwards timestamp without negative time", () => {
    const start = createReadClock(1000);
    expect(readClockElapsedMs(start, 500)).toBe(0);
    const paused = pauseReadClock(pauseReadClock(start, "idle", 2000), "idle", 5000);
    expect(paused.pauseReasons).toEqual(["idle"]);
    expect(readClockElapsedMs(paused, 10000)).toBe(1000);
    expect(Object.isFrozen(paused.pauseReasons)).toBe(true);
  });
  it.each([NaN, Infinity, -1])("rejects corrupt clock timestamps and snapshots %s", (value) => {
    expect(() => createReadClock(value)).toThrow();
    expect(() => restoreReadClock({ elapsedMs: value, pauseReasons: [] }, 0)).toThrow();
    expect(() => readClockElapsedMs(createReadClock(0), value)).toThrow();
  });
  it("rejects unknown pause reasons", () => {
    expect(() => restoreReadClock({ elapsedMs: 0, pauseReasons: ["whatever"] }, 0)).toThrow();
  });
});
