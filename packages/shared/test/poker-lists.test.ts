import { describe, expect, it } from "vitest";
import {
  pokerGameplayHandSchema,
  pokerLabCompletionRowSchema,
  pokerLabListMetaSchema,
  pokerLabListPageSchema,
  pokerLabPageHandoffSchema,
  pokerLabSystemMemorySchema,
} from "../src/index.js";

const page = {
  items: [{ id: "sample" }],
  nextCursor: "continuation",
  hasMore: true,
  total: 2,
  meta: {},
};

describe("Poker list IPC boundaries", () => {
  it("rejects impossible memory telemetry while accepting memory pressure", () => {
    expect(pokerLabSystemMemorySchema.parse({ totalBytes: 1024, availableBytes: 0 })).toEqual({
      totalBytes: 1024,
      availableBytes: 0,
    });
    for (const input of [
      { totalBytes: 1024, availableBytes: 1025 },
      { totalBytes: 0, availableBytes: 0 },
      { totalBytes: 1024, availableBytes: -1 },
      { totalBytes: Infinity, availableBytes: 0 },
    ])
      expect(pokerLabSystemMemorySchema.safeParse(input).success).toBe(false);
  });

  it("requires coherent continuation state and explicit metadata", () => {
    expect(pokerLabListPageSchema.parse(page)).toEqual(page);
    expect(
      pokerLabListPageSchema.parse({ ...page, nextCursor: null, hasMore: false }),
    ).toMatchObject({ nextCursor: null, hasMore: false });
    for (const input of [
      { ...page, nextCursor: null },
      { ...page, hasMore: false },
      { ...page, total: -1 },
      { ...page, meta: undefined },
    ])
      expect(pokerLabListPageSchema.safeParse(input).success).toBe(false);
    expect(pokerLabListMetaSchema.parse({ total: 0, meta: null })).toEqual({
      total: 0,
      meta: null,
    });
    expect(pokerLabListMetaSchema.safeParse({ total: 0 }).success).toBe(false);
  });

  it("limits navigation handoffs to the intended resource and dataset scopes", () => {
    const queue = {
      path: "/api/queue",
      datasetId: "working-dataset",
      query: { order: "newest" },
      storedAt: 123,
      page,
    };
    expect(pokerLabPageHandoffSchema.parse(queue)).toEqual(queue);
    expect(
      pokerLabPageHandoffSchema.safeParse({
        ...queue,
        path: "/api/gameplay",
        datasetId: null,
        query: { archived: "0" },
      }).success,
    ).toBe(true);
    for (const input of [
      { ...queue, datasetId: null },
      { ...queue, path: "/api/db_entries" },
      { ...queue, query: { order: "oldest" } },
      { ...queue, query: { order: "newest", search: "other" } },
      { ...queue, token: "unexpected" },
      { ...queue, path: "/api/gameplay", datasetId: null, query: { archived: "1" } },
    ])
      expect(pokerLabPageHandoffSchema.safeParse(input).success).toBe(false);
  });

  it("accepts legacy unidentified hands and numeric completion fields", () => {
    for (const hand_id of [null, "", "known"])
      expect(
        pokerGameplayHandSchema.safeParse({
          hand_id,
          frame_count: 1,
          first_at: "2026-01-01",
          last_at: "2026-01-01",
        }).success,
      ).toBe(true);
    expect(pokerLabCompletionRowSchema.parse({ score: "42", items: 10, rpm: "12.5" })).toEqual({
      score: "42",
      items: 10,
      rpm: "12.5",
    });
    const legacy = { score: "4.2e1", items: "010", rpm: null };
    expect(pokerLabCompletionRowSchema.parse(legacy)).toEqual(legacy);
    expect(pokerLabCompletionRowSchema.parse({ score: 42 })).toEqual({ score: 42 });
    expect(
      pokerLabCompletionRowSchema.safeParse({ score: "unknown", items: 10, rpm: 12.5 }).success,
    ).toBe(false);
  });
});
