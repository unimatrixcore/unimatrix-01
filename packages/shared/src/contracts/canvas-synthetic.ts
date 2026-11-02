import {
  canvasSyntheticCoursesSchema,
  canvasSyntheticStatusSchema,
} from "../schemas/canvas-synthetic.js";
import { defineApiContract } from "./api-contract.js";

export const canvasSyntheticStatusContract = defineApiContract({
  method: "GET",
  path: "/api/v1/status",
  responseSchema: canvasSyntheticStatusSchema,
});

export const canvasSyntheticCoursesContract = defineApiContract({
  method: "GET",
  path: "/api/v1/courses",
  responseSchema: canvasSyntheticCoursesSchema,
});
