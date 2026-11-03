import { describe, expect, it } from "vitest";

import { canvasAgendaContract, canvasAgendaQuerySchema, canvasAgendaSchema } from "../src/index.js";

describe("Canvas agenda contracts", () => {
  const window = { start: "2026-03-08", end: "2026-03-10" };

  it("normalizes HTTP arguments for the MCP workflow", () => {
    expect(canvasAgendaQuerySchema.parse({ ...window, courseIds: '["1","2"]' }).courseIds).toEqual([
      "1",
      "2",
    ]);
    expect(
      canvasAgendaQuerySchema.parse({
        ...window,
        timeZone: "America/New_York",
        courseIds: ["1"],
        limit: "2",
        fresh: "false",
      }),
    ).toEqual({
      ...window,
      timeZone: "America/New_York",
      courseIds: ["1"],
      limit: 2,
      fresh: false,
    });
    expect(canvasAgendaContract.path).toBe("/api/v1/agenda");
  });

  it("requires explicit date selectors, valid zones and opaque continuation", () => {
    for (const input of [
      {},
      { start: window.start },
      { ...window, end: "invalid" },
      { ...window, timeZone: "Mars/Olympus" },
      { ...window, courseIds: [1] },
      { ...window, courseIds: [] },
      { ...window, courseIds: "garbage" },
      { ...window, courseIds: "[1]" },
      { ...window, timeZone: "+03:00" },
      { ...window, cursor: "https://example.com/page2" },
      { ...window, cursor: "a".repeat(32), fresh: true },
      { ...window, userId: "1" },
    ])
      expect(canvasAgendaQuerySchema.safeParse(input).success).toBe(false);
    expect(
      canvasAgendaQuerySchema.safeParse({
        start: "2026-03-08T00:00:00-05:00",
        end: "2026-03-09T00:00:00-04:00",
      }).success,
    ).toBe(true);
    expect(
      canvasAgendaQuerySchema.safeParse({ start: "2026-11-03T01:00:00Z", end: "2026-11-03" })
        .success,
    ).toBe(true);
    expect(
      canvasAgendaQuerySchema.safeParse({
        start: "2026-10-01",
        end: "2027-01-02T04:00:00Z",
        timeZone: "America/New_York",
      }).success,
    ).toBe(true);
  });

  it("preserves unknown nothing-due interpretation on partial results", () => {
    expect(
      canvasAgendaSchema.parse({
        items: [],
        sources: [],
        coverage: "partial",
        nothingDue: null,
        effectiveTimeZone: "America/Phoenix",
        timeZoneSource: "configured",
        continuation: "a".repeat(32),
      }).nothingDue,
    ).toBeNull();
  });
});
