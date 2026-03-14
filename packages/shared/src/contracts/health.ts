import type { HealthResponse } from "../schemas/health.js";
import { healthResponseSchema } from "../schemas/health.js";
import { defineApiContract } from "./api-contract.js";

export const healthContract = defineApiContract({
  method: "GET",
  path: "/health",
  responseSchema: healthResponseSchema,
});

export type HealthContract = typeof healthContract;
export type { HealthResponse };