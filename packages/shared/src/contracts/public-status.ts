import {
  publicDeploymentStatusQuerySchema,
  publicDeploymentStatusResponseSchema,
} from "../schemas/public-status.js";
import { defineApiContract } from "./api-contract.js";

export const publicDeploymentStatusContract = defineApiContract({
  method: "GET",
  path: "/deployment/status",
  querySchema: publicDeploymentStatusQuerySchema,
  responseSchema: publicDeploymentStatusResponseSchema,
});
