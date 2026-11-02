import { z } from "zod";

export const canvasSyntheticStatusSchema = z.strictObject({
  mode: z.literal("synthetic"),
  connection: z.literal("synthetic"),
  courseCount: z.number().int().nonnegative(),
});

export const canvasSyntheticCoursesSchema = z.strictObject({
  mode: z.literal("synthetic"),
  courses: z.array(
    z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1),
      workflowState: z.literal("available"),
    }),
  ),
});

export const canvasSyntheticEchoInputSchema = z.strictObject({ message: z.string().max(256) });
export const canvasSyntheticEchoSchema = z.strictObject({ message: z.string().max(256) });

export type CanvasSyntheticStatus = z.output<typeof canvasSyntheticStatusSchema>;
export type CanvasSyntheticCourses = z.output<typeof canvasSyntheticCoursesSchema>;
export type CanvasSyntheticEcho = z.output<typeof canvasSyntheticEchoSchema>;
