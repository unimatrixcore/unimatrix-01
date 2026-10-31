import {
  deployAttemptIntentSchema,
  deployAttemptReportSchema,
  deployAttemptQuerySchema,
  deployAttemptResponseSchema,
  deployAttemptHistoryResponseSchema,
} from "../schemas/deployment-attempts.js";
import { defineApiContract } from "./api-contract.js";

export const deployAttemptIntentContract = defineApiContract({
  method: "POST",
  path: "/deployment/attempts/intent",
  bodySchema: deployAttemptIntentSchema,
  responseSchema: deployAttemptResponseSchema,
});
export const deployAttemptReportContract = defineApiContract({
  method: "POST",
  path: "/deployment/attempts/report",
  bodySchema: deployAttemptReportSchema,
  responseSchema: deployAttemptResponseSchema,
});
export const deployAttemptHistoryContract = defineApiContract({
  method: "GET",
  path: "/deployment/attempts",
  querySchema: deployAttemptQuerySchema,
  responseSchema: deployAttemptHistoryResponseSchema,
});
