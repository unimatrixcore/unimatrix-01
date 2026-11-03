import { describe, expect, it } from "vitest";

import { canvasCourseQuerySchema, canvasCoursesQuerySchema } from "../src/index.js";

describe("Canvas query boundaries", () => {
  it("normalizes HTTP scalars and preserves typed MCP arguments", () => {
    expect(
      canvasCoursesQuerySchema.parse({ concluded: "false", fresh: "true", limit: "10" }),
    ).toEqual({ concluded: false, fresh: true, limit: 10 });
    expect(canvasCoursesQuerySchema.parse({ concluded: false, fresh: true, limit: 10 })).toEqual({
      concluded: false,
      fresh: true,
      limit: 10,
    });
    expect(
      canvasCourseQuerySchema.parse({ courseId: "9007199254740993123", concluded: "true" }),
    ).toEqual({ courseId: "9007199254740993123", concluded: true });
  });

  it("rejects ambiguous booleans, unsafe identifiers, over-budget limits and unbound input", () => {
    for (const input of [
      { concluded: "0" },
      { fresh: "yes" },
      { limit: 0 },
      { limit: "101" },
      { limit: "1.5" },
      { cursor: "https://attacker.example/page" },
      { caller: "someone" },
    ]) {
      expect(canvasCoursesQuerySchema.safeParse(input).success).toBe(false);
    }
    for (const courseId of ["0", "../courses/1", "1.5", 9007199254740992]) {
      expect(canvasCourseQuerySchema.safeParse({ courseId }).success).toBe(false);
    }
  });
});
