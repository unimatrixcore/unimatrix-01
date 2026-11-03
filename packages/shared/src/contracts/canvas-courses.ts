import {
  canvasCourseQuerySchema,
  canvasCourseResponseSchema,
  canvasCoursesQuerySchema,
  canvasCoursesSchema,
} from "../schemas/canvas-courses.js";
import { canvasConnectionStatusSchema } from "../schemas/canvas-connection.js";
import { defineApiContract } from "./api-contract.js";

export const canvasStatusContract = defineApiContract({
  method: "GET",
  path: "/api/v1/status",
  responseSchema: canvasConnectionStatusSchema,
});
export const canvasCoursesContract = defineApiContract({
  method: "GET",
  path: "/api/v1/courses",
  querySchema: canvasCoursesQuerySchema,
  responseSchema: canvasCoursesSchema,
});
export const canvasCourseContract = defineApiContract({
  method: "GET",
  path: "/api/v1/course",
  querySchema: canvasCourseQuerySchema,
  responseSchema: canvasCourseResponseSchema,
});
