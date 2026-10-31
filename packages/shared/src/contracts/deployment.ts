import {
  deployDeclarationsQuerySchema,
  deployDeclarationsResponseSchema,
} from "../schemas/deployment-declarations.js";
import {
  deployHealthHistoryQuerySchema,
  deployHealthHistoryResponseSchema,
  deployReconciliationQuerySchema,
  deployReconciliationResponseSchema,
  deployStateQuerySchema,
  deployStateResponseSchema,
} from "../schemas/deployment.js";
import { defineApiContract } from "./api-contract.js";

export const deployStateContract = defineApiContract({
  method: "GET",
  path: "/deployment/state",
  querySchema: deployStateQuerySchema,
  responseSchema: deployStateResponseSchema,
});

export const deployHealthHistoryContract = defineApiContract({
  method: "GET",
  path: "/deployment/health",
  querySchema: deployHealthHistoryQuerySchema,
  responseSchema: deployHealthHistoryResponseSchema,
});

export const deployReconciliationContract = defineApiContract({
  method: "GET",
  path: "/deployment/reconciliation",
  querySchema: deployReconciliationQuerySchema,
  responseSchema: deployReconciliationResponseSchema,
});

export type DeployStateContract = typeof deployStateContract;
export type DeployHealthHistoryContract = typeof deployHealthHistoryContract;
export type DeployReconciliationContract = typeof deployReconciliationContract;

export const deployDeclarationsContract = defineApiContract({
  method: "GET",
  path: "/deployment/declarations",
  querySchema: deployDeclarationsQuerySchema,
  responseSchema: deployDeclarationsResponseSchema,
});

export type DeployDeclarationsContract = typeof deployDeclarationsContract;
