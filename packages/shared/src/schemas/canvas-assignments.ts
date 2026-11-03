import { z } from "zod";

import {
  canvasCourseQuerySchema,
  canvasCoursesQuerySchema,
  canvasCourseSourceSchema,
} from "./canvas-courses.js";

const id = canvasCourseQuerySchema.shape.courseId;
const integer = z.union([z.number(), z.string().regex(/^\d+$/u).transform(Number)]);
export const canvasAssignmentsQuerySchema = canvasCoursesQuerySchema.extend({ courseId: id });
export const canvasSubmissionQuerySchema = canvasCourseQuerySchema.extend({ assignmentId: id });
export const canvasAssignmentQuerySchema = canvasSubmissionQuerySchema
  .extend({
    instructionDocumentId: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    instructionOffset: integer.pipe(z.number().int().positive().max(2_000_000)).optional(),
  })
  .refine(
    (value) =>
      (value.instructionDocumentId === undefined) === (value.instructionOffset === undefined),
  );
export const canvasGradesQuerySchema = canvasCourseQuerySchema.extend({
  gradingPeriodId: id.optional(),
});

export const canvasDocumentSchema = z.strictObject({
  format: z.literal("markdown"),
  trust: z.literal("untrusted"),
  text: z.string(),
  source: z.strictObject({
    url: z.url(),
    documentId: z.string().regex(/^[a-f0-9]{64}$/u),
    inputBytes: z.number().int().nonnegative(),
  }),
  totalCharacters: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  truncated: z.boolean(),
  continuation: z
    .strictObject({
      documentId: z.string().regex(/^[a-f0-9]{64}$/u),
      offset: z.number().int().positive(),
    })
    .nullable(),
});
const nullableText = z.string().nullable().optional();
const dates = { due_at: nullableText, lock_at: nullableText, unlock_at: nullableText };
export const canvasRubricCriterionSchema = z.strictObject({
  id: z.string(),
  points: z.number().optional(),
  description: z.string().optional(),
  long_description: nullableText,
});
export const canvasRubricSettingsSchema = z.strictObject({
  id: id.optional(),
  title: z.string().optional(),
  points_possible: z.union([z.number(), z.string().regex(/^-?\d+(?:\.\d+)?$/u)]).optional(),
});
export const canvasAssignmentOverrideSchema = z.strictObject({
  id,
  assignment_id: id.optional(),
  student_ids: z.array(id).optional(),
  course_section_id: id.nullable().optional(),
  group_id: id.nullable().optional(),
  title: z.string().optional(),
  ...dates,
});
export const canvasAssignmentDateSchema = z.strictObject({
  id: id.optional(),
  base: z.boolean().optional(),
  title: z.string().optional(),
  ...dates,
});
const included = z.enum(["included", "absent"]);
export const canvasAssignmentSchema = z.strictObject({
  id,
  courseId: id,
  name: z.string(),
  htmlUrl: z.url(),
  dueAt: z.string().nullable().optional(),
  lockAt: z.string().nullable().optional(),
  unlockAt: z.string().nullable().optional(),
  submissionTypes: z.array(z.string()).optional(),
  pointsPossible: z.number().nullable().optional(),
  published: z.boolean().optional(),
  lockedForUser: z.boolean().optional(),
  lockExplanation: z.string().nullable().optional(),
  onlyVisibleToOverrides: z.boolean().optional(),
  hasOverrides: z.boolean().optional(),
  assignmentVisibility: z.array(id).nullable().optional(),
  allDates: z.array(canvasAssignmentDateSchema).nullable().optional(),
  rubric: z.array(canvasRubricCriterionSchema).nullable().optional(),
  rubricSettings: canvasRubricSettingsSchema.nullable().optional(),
  overrides: z.array(canvasAssignmentOverrideSchema).nullable().optional(),
  useRubricForGrading: z.boolean().optional(),
  gradingType: z.string().optional(),
  omitFromFinalGrade: z.boolean().optional(),
  hideInGradebook: z.boolean().optional(),
  instructions: canvasDocumentSchema.nullable(),
  instructionsAvailability: z.enum(["included", "absent", "unavailable"]),
  omittedFields: z.array(z.string()).max(32),
  warnings: z.array(z.string()).max(32),
  includes: z.strictObject({
    visibility: included,
    submission: included,
    rubric: included,
    overrides: included,
  }),
});
const sources = z.array(canvasCourseSourceSchema);
export const canvasAssignmentsSchema = z.strictObject({
  assignments: z.array(canvasAssignmentSchema).max(100),
  sources,
  continuation: z.string().optional(),
});
export const canvasAssignmentResponseSchema = z.strictObject({
  assignment: canvasAssignmentSchema,
  sources,
});
export const canvasSubmissionResponseSchema = z.strictObject({
  courseId: id,
  assignmentId: id,
  submission: z.strictObject({
    attempt: z.number().int().nonnegative().nullable().optional(),
    workflowState: z.string(),
    submissionType: z.string().nullable().optional(),
    gradedAt: z.string().nullable().optional(),
    cachedDueDate: z.string().nullable().optional(),
    submittedAt: z.string().nullable().optional(),
    missing: z.boolean().optional(),
    late: z.boolean().optional(),
    excused: z.boolean().nullable().optional(),
    gradeMatchesCurrentSubmission: z.boolean().optional(),
    postedAt: z.string().nullable().optional(),
    grade: z.string().nullable().optional(),
    score: z.number().nullable().optional(),
    gradeVisibility: z.enum(["visible", "hidden", "unknown", "ungraded"]),
  }),
  sources,
});
export const canvasGradesResponseSchema = z.strictObject({
  grades: z.array(
    z.strictObject({
      courseId: id,
      enrollmentId: id.nullable(),
      enrollmentState: z.string().nullable(),
      gradingPeriodId: id.nullable(),
      grades: z
        .strictObject({
          currentScore: z.number().nullable().optional(),
          currentGrade: z.string().nullable().optional(),
          finalScore: z.number().nullable().optional(),
          finalGrade: z.string().nullable().optional(),
        })
        .nullable(),
      gradeVisibility: z.enum(["reported", "absent"]),
    }),
  ),
  sources,
});
export type CanvasAssignmentsQuery = z.output<typeof canvasAssignmentsQuerySchema>;
export type CanvasAssignmentQuery = z.output<typeof canvasAssignmentQuerySchema>;
export type CanvasSubmissionQuery = z.output<typeof canvasSubmissionQuerySchema>;
export type CanvasGradesQuery = z.output<typeof canvasGradesQuerySchema>;
export type CanvasAssignmentsResponse = z.output<typeof canvasAssignmentsSchema>;
export type CanvasAssignmentResponse = z.output<typeof canvasAssignmentResponseSchema>;
export type CanvasSubmissionResponse = z.output<typeof canvasSubmissionResponseSchema>;
export type CanvasGradesResponse = z.output<typeof canvasGradesResponseSchema>;
