import {
  canvasSyllabusQuerySchema,
  canvasSyllabusResponseSchema,
  canvasAnnouncementsQuerySchema,
  canvasAnnouncementsSchema,
  canvasPagesQuerySchema,
  canvasPagesSchema,
  canvasPageQuerySchema,
  canvasPageResponseSchema,
  canvasModulesQuerySchema,
  canvasModulesSchema,
  canvasModuleItemsQuerySchema,
  canvasModuleItemsSchema,
  canvasFilesQuerySchema,
  canvasFilesSchema,
  canvasFileQuerySchema,
  canvasFileResponseSchema,
} from "../schemas/canvas-reading.js";
import { defineApiContract } from "./api-contract.js";

export const canvasSyllabusContract = defineApiContract({
  method: "GET",
  path: "/api/v1/syllabus",
  querySchema: canvasSyllabusQuerySchema,
  responseSchema: canvasSyllabusResponseSchema,
});
export const canvasAnnouncementsContract = defineApiContract({
  method: "GET",
  path: "/api/v1/announcements",
  querySchema: canvasAnnouncementsQuerySchema,
  responseSchema: canvasAnnouncementsSchema,
});
export const canvasPagesContract = defineApiContract({
  method: "GET",
  path: "/api/v1/pages",
  querySchema: canvasPagesQuerySchema,
  responseSchema: canvasPagesSchema,
});
export const canvasPageContract = defineApiContract({
  method: "GET",
  path: "/api/v1/page",
  querySchema: canvasPageQuerySchema,
  responseSchema: canvasPageResponseSchema,
});
export const canvasModulesContract = defineApiContract({
  method: "GET",
  path: "/api/v1/modules",
  querySchema: canvasModulesQuerySchema,
  responseSchema: canvasModulesSchema,
});
export const canvasModuleItemsContract = defineApiContract({
  method: "GET",
  path: "/api/v1/module-items",
  querySchema: canvasModuleItemsQuerySchema,
  responseSchema: canvasModuleItemsSchema,
});
export const canvasFilesContract = defineApiContract({
  method: "GET",
  path: "/api/v1/files",
  querySchema: canvasFilesQuerySchema,
  responseSchema: canvasFilesSchema,
});
export const canvasFileContract = defineApiContract({
  method: "GET",
  path: "/api/v1/file",
  querySchema: canvasFileQuerySchema,
  responseSchema: canvasFileResponseSchema,
});
