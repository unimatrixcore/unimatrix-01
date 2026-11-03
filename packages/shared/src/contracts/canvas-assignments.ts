import {
  canvasAssignmentsQuerySchema,
  canvasAssignmentQuerySchema,
  canvasSubmissionQuerySchema,
  canvasGradesQuerySchema,
  canvasAssignmentsSchema,
  canvasAssignmentResponseSchema,
  canvasSubmissionResponseSchema,
  canvasGradesResponseSchema,
} from "../schemas/canvas-assignments.js";
import { defineApiContract } from "./api-contract.js";

export const canvasAssignmentsContract = defineApiContract({
  method: "GET",
  path: "/api/v1/assignments",
  querySchema: canvasAssignmentsQuerySchema,
  responseSchema: canvasAssignmentsSchema,
});
export const canvasAssignmentContract = defineApiContract({
  method: "GET",
  path: "/api/v1/assignment",
  querySchema: canvasAssignmentQuerySchema,
  responseSchema: canvasAssignmentResponseSchema,
});
export const canvasSubmissionContract = defineApiContract({
  method: "GET",
  path: "/api/v1/submission",
  querySchema: canvasSubmissionQuerySchema,
  responseSchema: canvasSubmissionResponseSchema,
});
export const canvasGradesContract = defineApiContract({
  method: "GET",
  path: "/api/v1/grades",
  querySchema: canvasGradesQuerySchema,
  responseSchema: canvasGradesResponseSchema,
});
