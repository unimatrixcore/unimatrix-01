import { z } from "zod";

import {
  canvasCourseQuerySchema,
  canvasCoursesQuerySchema,
  canvasCourseSourceSchema,
} from "./canvas-courses.js";

const id = canvasCourseQuerySchema.shape.courseId;
const date = z.iso.datetime({ offset: true }).or(z.iso.date());
const timeZone = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => {
    try {
      if (/^[+-]/u.test(value)) return false;
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  });

export const canvasAgendaQuerySchema = canvasCoursesQuerySchema
  .omit({ concluded: true })
  .extend({
    start: date,
    end: date,
    timeZone: timeZone.optional(),
    courseIds: z
      .union([
        z.array(id),
        z
          .string()
          .max(14_000)
          .transform((value, context): unknown => {
            try {
              return JSON.parse(value) as unknown;
            } catch {
              context.addIssue({ code: "custom", message: "Invalid course IDs." });
              return z.NEVER;
            }
          })
          .pipe(z.array(id)),
      ])
      .pipe(z.array(id).min(1).max(100))
      .optional(),
  })
  .refine((value) => {
    const duration = Date.parse(value.end) - Date.parse(value.start);
    return duration > 0 && duration <= 93 * 86_400_000;
  })
  .refine((value) => !(value.cursor && value.fresh));

export const canvasAgendaEvidenceSchema = z.strictObject({
  source: z.enum(["planner", "calendar", "missingSubmissions", "assignment"]),
  id: z.string(),
  date: date.nullable(),
  completed: z.boolean().nullable(),
  dismissed: z.boolean().nullable(),
});

export const canvasAgendaItemSchema = z.strictObject({
  key: z.string(),
  kind: z.enum(["assignment", "event", "note"]),
  courseId: id.nullable(),
  assignmentId: id.nullable(),
  title: z.string(),
  htmlUrl: z.url().nullable(),
  dueAt: date.nullable(),
  lockAt: date.nullable(),
  unlockAt: date.nullable(),
  submissionTypes: z.array(z.string()).nullable(),
  startAt: date.nullable(),
  endAt: date.nullable(),
  allDay: z.boolean(),
  allDayDate: z.iso.date().nullable(),
  submission: z
    .strictObject({
      workflowState: z.string(),
      attempt: z.number().int().nonnegative().nullable(),
      submissionType: z.string().nullable(),
      gradeMatchesCurrentSubmission: z.boolean().nullable(),
      submittedAt: z.iso.datetime({ offset: true }).nullable(),
      missing: z.boolean().nullable(),
      late: z.boolean().nullable(),
      excused: z.boolean().nullable(),
    })
    .nullable(),
  overdue: z.boolean().nullable(),
  evidence: z.array(canvasAgendaEvidenceSchema),
});

export const canvasAgendaSchema = z.strictObject({
  items: z.array(canvasAgendaItemSchema).max(100),
  sources: z.array(canvasCourseSourceSchema),
  coverage: z.enum(["complete", "partial"]),
  nothingDue: z.boolean().nullable(),
  effectiveTimeZone: timeZone,
  timeZoneSource: z.enum(["requested", "configured"]),
  continuation: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32}$/u)
    .optional(),
});

export type CanvasAgendaQuery = z.output<typeof canvasAgendaQuerySchema>;
export type CanvasAgendaEvidence = z.output<typeof canvasAgendaEvidenceSchema>;
export type CanvasAgendaItem = z.output<typeof canvasAgendaItemSchema>;
export type CanvasAgendaResponse = z.output<typeof canvasAgendaSchema>;
