import {
  canvasSyntheticCoursesSchema,
  canvasSyntheticEchoInputSchema,
  canvasSyntheticEchoSchema,
  canvasSyntheticStatusSchema,
  type CanvasSyntheticStatus,
  type CanvasSyntheticCourses,
  type CanvasSyntheticEcho,
} from "@unimatrix/shared";

export function listSyntheticCourses(): CanvasSyntheticCourses {
  return canvasSyntheticCoursesSchema.parse({
    mode: "synthetic",
    courses: [
      { id: "synthetic-astro-101", name: "Synthetic Astrobiology", workflowState: "available" },
      { id: "synthetic-math-101", name: "Synthetic Mathematics", workflowState: "available" },
    ],
  });
}

export function getSyntheticStatus(): CanvasSyntheticStatus {
  return canvasSyntheticStatusSchema.parse({
    mode: "synthetic",
    connection: "synthetic",
    courseCount: listSyntheticCourses().courses.length,
  });
}

export function echoSynthetic(input: unknown): CanvasSyntheticEcho {
  return canvasSyntheticEchoSchema.parse(canvasSyntheticEchoInputSchema.parse(input));
}
