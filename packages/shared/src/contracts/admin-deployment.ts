import {
  deployAttemptHistoryResponseSchema,
  deployAttemptQuerySchema,
} from "../schemas/deployment-attempts.js";
import {
  deployHealthHistoryQuerySchema,
  deployHealthHistoryResponseSchema,
  deployReconciliationQuerySchema,
  deployReconciliationResponseSchema,
  deployStateQuerySchema,
  deployStateResponseSchema,
} from "../schemas/deployment.js";
import { defineApiContract } from "./api-contract.js";

export const adminDeployStateContract = defineApiContract({
  method: "GET",
  path: "/deployment/admin/state",
  querySchema: deployStateQuerySchema,
  responseSchema: deployStateResponseSchema,
});

export const adminDeployHealthHistoryContract = defineApiContract({
  method: "GET",
  path: "/deployment/admin/health",
  querySchema: deployHealthHistoryQuerySchema,
  responseSchema: deployHealthHistoryResponseSchema,
});

export const adminDeployReconciliationContract = defineApiContract({
  method: "GET",
  path: "/deployment/admin/reconciliation",
  querySchema: deployReconciliationQuerySchema,
  responseSchema: deployReconciliationResponseSchema,
});

export const adminDeployAttemptHistoryContract = defineApiContract({
  method: "GET",
  path: "/deployment/admin/attempts",
  querySchema: deployAttemptQuerySchema,
  responseSchema: deployAttemptHistoryResponseSchema,
});

export type AdminDeployStateContract = typeof adminDeployStateContract;
export type AdminDeployHealthHistoryContract = typeof adminDeployHealthHistoryContract;
export type AdminDeployReconciliationContract = typeof adminDeployReconciliationContract;
export type AdminDeployAttemptHistoryContract = typeof adminDeployAttemptHistoryContract;
