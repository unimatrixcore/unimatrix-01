import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearLabPageHandoff,
  consumeLabPageHandoff,
  handoffGeneration,
  storeLabPageHandoff,
} from "../src/lib/lab-page-handoff";
const page = {
  items: [{ id: "pot", sample_key: "sample" }],
  nextCursor: null,
  hasMore: false,
  total: 1,
  meta: {},
};
const value = () => ({
  path: "/api/queue",
  datasetId: "dataset",
  query: { order: "newest" },
  storedAt: Date.now(),
  page,
});
beforeEach(() => {
  sessionStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
});
it("consumes a validated matching first page exactly once", () => {
  storeLabPageHandoff(value(), handoffGeneration());
  expect(consumeLabPageHandoff("/api/datasets", undefined, {})).toBeUndefined();
  expect(consumeLabPageHandoff("/api/queue", "dataset", { order: "newest" })).toEqual(page);
  expect(consumeLabPageHandoff("/api/queue", "dataset", { order: "newest" })).toBeUndefined();
});
it("rejects stale, mismatched, oversized and invalidated entries", () => {
  storeLabPageHandoff(value(), handoffGeneration());
  vi.advanceTimersByTime(15001);
  expect(consumeLabPageHandoff("/api/queue", "dataset", { order: "newest" })).toBeUndefined();
  storeLabPageHandoff(value(), handoffGeneration());
  expect(consumeLabPageHandoff("/api/queue", "other", { order: "newest" })).toBeUndefined();
  storeLabPageHandoff(
    { ...value(), page: { ...page, items: Array.from({ length: 101 }, () => ({ id: "pot" })) } },
    handoffGeneration(),
  );
  expect(sessionStorage.length).toBe(0);
  const generation = handoffGeneration();
  clearLabPageHandoff();
  storeLabPageHandoff(value(), generation);
  expect(sessionStorage.length).toBe(0);
});
