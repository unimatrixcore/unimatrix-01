import { describe, expect, it } from "vitest";
import {
  canvasRubricCriterionSchema,
  canvasRubricSettingsSchema,
  canvasAssignmentOverrideSchema,
  canvasAssignmentDateSchema,
  canvasAssignmentsQuerySchema,
  canvasAssignmentQuerySchema,
  canvasGradesQuerySchema,
  canvasSubmissionResponseSchema,
} from "../src/index.js";

describe("Canvas coursework contracts", () => {
  it("normalizes HTTP limits and continuation offsets for the same MCP workflow", () => {
    expect(
      canvasAssignmentsQuerySchema.parse({ courseId: "1", limit: "2", concluded: "false" }),
    ).toEqual({ courseId: "1", limit: 2, concluded: false });
    const documentId = "a".repeat(64);
    expect(
      canvasAssignmentQuerySchema.parse({
        courseId: "1",
        assignmentId: "2",
        instructionDocumentId: documentId,
        instructionOffset: "1500",
      }).instructionOffset,
    ).toBe(1500);
  });
  it("rejects incomplete instruction continuation and arbitrary caller or student selectors", () => {
    for (const args of [
      { instructionOffset: 2 },
      { instructionDocumentId: "a".repeat(64) },
      { instructionOffset: 0, instructionDocumentId: "a".repeat(64) },
      { userId: "2" },
    ]) {
      expect(
        canvasAssignmentQuerySchema.safeParse({ courseId: "1", assignmentId: "2", ...args })
          .success,
      ).toBe(false);
    }
    expect(canvasGradesQuerySchema.safeParse({ courseId: "1", gradingPeriodId: "0" }).success).toBe(
      false,
    );
  });
  it("keeps explicit ungraded nulls, excused flags and visible zeroes distinct", () => {
    const parse = (submission: unknown) =>
      canvasSubmissionResponseSchema.parse({
        courseId: "1",
        assignmentId: "2",
        sources: [],
        submission,
      }).submission;
    expect(
      parse({ workflowState: "unsubmitted", gradeVisibility: "ungraded", score: null, grade: null })
        .score,
    ).toBeNull();
    expect(
      parse({
        workflowState: "graded",
        gradeVisibility: "visible",
        score: 0,
        grade: "0",
        excused: false,
      }).score,
    ).toBe(0);
    expect(
      parse({ workflowState: "graded", gradeVisibility: "hidden", excused: true }).excused,
    ).toBe(true);
  });
});

describe("Canvas association response boundaries", () => {
  it("accepts selected association fields and rejects arbitrary nested payloads", () => {
    for (const [schema, valid] of [
      [
        canvasRubricCriterionSchema,
        { id: "criterion", points: 10, description: "Synthetic criterion" },
      ],
      [canvasRubricSettingsSchema, { id: "3", points_possible: "10" }],
      [canvasAssignmentOverrideSchema, { id: "4", student_ids: ["5"], due_at: null }],
      [canvasAssignmentDateSchema, { base: true, due_at: null }],
    ] as const) {
      expect(schema.safeParse(valid).success).toBe(true);
      expect(schema.safeParse({ ...valid, arbitrary: { nested: "payload" } }).success).toBe(false);
    }
    expect(
      canvasRubricCriterionSchema.safeParse({ id: "criterion", ratings: [{ arbitrary: true }] })
        .success,
    ).toBe(false);
    expect(canvasAssignmentOverrideSchema.safeParse({ id: "4", student_ids: [5] }).success).toBe(
      false,
    );
  });
});
