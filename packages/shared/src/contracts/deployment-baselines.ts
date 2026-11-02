import {
  deployBaselinesQuerySchema,
  deployBaselinesResponseSchema,
} from "../schemas/deployment-baselines.js";
import { defineApiContract } from "./api-contract.js";

export const deployBaselinesContract = defineApiContract({
  method: "GET",
  path: "/deployment/baselines",
  querySchema: deployBaselinesQuerySchema,
  responseSchema: deployBaselinesResponseSchema,
});

export type DeployBaselinesContract = typeof deployBaselinesContract;
