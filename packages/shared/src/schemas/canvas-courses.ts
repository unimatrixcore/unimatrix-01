import { z } from "zod";

const id = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .max(128);
const flag = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);
const filters = { concluded: flag.optional(), fresh: flag.optional() };

export const canvasCoursesQuerySchema = z.strictObject({
  ...filters,
  limit: z
    .union([z.number(), z.string().regex(/^\d+$/u).transform(Number)])
    .pipe(z.number().int().min(1).max(100))
    .optional(),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32}$/u)
    .optional(),
});
export const canvasCourseQuerySchema = z.strictObject({ ...filters, courseId: id });

export const canvasCourseSchema = z.strictObject({
  id,
  name: z.string().nullable(),
  courseCode: z.string().nullable(),
  workflowState: z.string().nullable(),
  timeZone: z.string().nullable(),
  effectiveTimeZone: z.string(),
  timeZoneSource: z.enum(["course", "configured"]),
  htmlUrl: z.url(),
  enrollmentState: z.enum(["active", "completed"]),
});

export const canvasCourseSourceSchema = z.strictObject({
  source: z.url(),
  sourceLinks: z.array(z.url()),
  coverage: z.enum(["complete", "partial", "unavailable", "not_requested"]),
  retrievedAt: z.iso.datetime().nullable(),
  cacheAgeMs: z.number().nonnegative(),
  warnings: z.array(z.string()),
});
export const canvasCoursesSchema = z.strictObject({
  courses: z.array(canvasCourseSchema).max(100),
  sources: z.array(canvasCourseSourceSchema),
  continuation: z.string().min(1).max(256).optional(),
});
export const canvasCourseResponseSchema = z.strictObject({
  course: canvasCourseSchema,
  sources: z.array(canvasCourseSourceSchema),
});

export type CanvasCoursesQuery = z.output<typeof canvasCoursesQuerySchema>;
export type CanvasCourseQuery = z.output<typeof canvasCourseQuerySchema>;
export type CanvasCourse = z.output<typeof canvasCourseSchema>;
export type CanvasCoursesResponse = z.output<typeof canvasCoursesSchema>;
export type CanvasCourseResponse = z.output<typeof canvasCourseResponseSchema>;
