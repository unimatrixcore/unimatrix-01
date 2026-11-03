import { canvasAgendaQuerySchema, canvasAgendaSchema } from "../schemas/canvas-agenda.js";
import { defineApiContract } from "./api-contract.js";

export const canvasAgendaContract = defineApiContract({
  method: "GET",
  path: "/api/v1/agenda",
  querySchema: canvasAgendaQuerySchema,
  responseSchema: canvasAgendaSchema,
});
