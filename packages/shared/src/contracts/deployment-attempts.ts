import {
  deployAttemptIntentSchema,
  deployAttemptBatchIntentSchema,
  deployAttemptBatchIntentResponseSchema,
  deployManualRedeployInputSchema,
  deployRollbackInputSchema,
  deployExecuteInputSchema,
  deployAttemptReportSchema,
  deployAttemptQuerySchema,
  deployAttemptResponseSchema,
  deployAttemptHistoryResponseSchema,
  deployAttemptLogsQuerySchema,
  deployAttemptLogsResponseSchema,
} from "../schemas/deployment-attempts.js";
import { defineApiContract } from "./api-contract.js";

export const deployAttemptIntentContract = defineApiContract({
  method: "POST",
  path: "/deployment/attempts/intent",
  bodySchema: deployAttemptIntentSchema,
  responseSchema: deployAttemptResponseSchema,
});
export const deployAttemptBatchIntentContract = defineApiContract({
  method: "POST",
  path: "/deployment/attempts/intent",
  bodySchema: deployAttemptBatchIntentSchema,
  responseSchema: deployAttemptBatchIntentResponseSchema,
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
export const deployAttemptLogsContract = defineApiContract({
  method: "GET",
  path: "/deployment/attempts/logs",
  querySchema: deployAttemptLogsQuerySchema,
  responseSchema: deployAttemptLogsResponseSchema,
});

export const deployManualRedeployContract = defineApiContract({
  method: "POST",
  path: "/deployment/redeploy",
  bodySchema: deployManualRedeployInputSchema,
  responseSchema: deployAttemptResponseSchema,
});

export const deployRollbackContract = defineApiContract({
  method: "POST",
  path: "/deployment/rollback",
  bodySchema: deployRollbackInputSchema,
  responseSchema: deployAttemptResponseSchema,
});

export const deployExecuteContract = defineApiContract({
  method: "POST",
  path: "/deployment/execute",
  bodySchema: deployExecuteInputSchema,
  responseSchema: deployAttemptResponseSchema,
});
