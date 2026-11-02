import { canvasConnectionStatusSchema } from "../schemas/canvas-connection.js";
import { defineApiContract } from "./api-contract.js";

export const canvasConnectionStatusContract = defineApiContract({
  method: "GET",
  path: "/api/v1/connection",
  responseSchema: canvasConnectionStatusSchema,
});
