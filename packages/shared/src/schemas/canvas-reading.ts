import { z } from "zod";

import {
  canvasCourseQuerySchema,
  canvasCoursesQuerySchema,
  canvasCourseSourceSchema,
} from "./canvas-courses.js";
import { canvasAgendaQuerySchema } from "./canvas-agenda.js";
import { canvasDocumentSchema } from "./canvas-assignments.js";

const id = canvasCourseQuerySchema.shape.courseId;
const integer = z.union([z.number(), z.string().regex(/^\d+$/u).transform(Number)]);
const documentContinuation = {
  documentId: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  offset: integer.pipe(z.number().int().positive().max(2_000_000)).optional(),
};
const pairedDocument = (value: { documentId?: string | undefined; offset?: number | undefined }) =>
  (value.documentId === undefined) === (value.offset === undefined);
const list = canvasCoursesQuerySchema.extend({ courseId: id });
export const canvasSyllabusQuerySchema = canvasCourseQuerySchema
  .extend(documentContinuation)
  .refine(pairedDocument);
export const canvasPagesQuerySchema = list;
export const canvasPageQuerySchema = canvasCourseQuerySchema
  .extend({
    selector: z.enum(["front_page", "id", "slug"]),
    pageId: id.optional(),
    pageSlug: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/u)
      .optional(),
    ...documentContinuation,
  })
  .refine(pairedDocument)
  .refine((value) => {
    if (value.selector === "front_page")
      return value.pageId === undefined && value.pageSlug === undefined;
    if (value.selector === "id") return value.pageId !== undefined && value.pageSlug === undefined;
    return value.pageSlug !== undefined && value.pageId === undefined;
  });
export const canvasAnnouncementsQuerySchema = canvasCoursesQuerySchema
  .omit({ concluded: true })
  .extend({
    start: canvasAgendaQuerySchema.shape.start,
    end: canvasAgendaQuerySchema.shape.end,
    courseIds: canvasAgendaQuerySchema.shape.courseIds.unwrap(),
    announcementId: id.optional(),
    ...documentContinuation,
  })
  .refine(pairedDocument)
  .refine((value) => value.documentId === undefined || value.announcementId !== undefined)
  .refine((value) => Date.parse(value.start) <= Date.parse(value.end));
export const canvasModulesQuerySchema = list;
export const canvasModuleItemsQuerySchema = list.extend({ moduleId: id });
export const canvasFilesQuerySchema = list;
export const canvasFileQuerySchema = canvasCourseQuerySchema.extend({ fileId: id });

const document = {
  document: canvasDocumentSchema.nullable(),
  availability: z.enum(["included", "absent", "unavailable", "not_requested"]),
  warnings: z.array(z.string()).max(32),
};
export const canvasSyllabusSchema = z.strictObject({ courseId: id, htmlUrl: z.url(), ...document });
export const canvasAnnouncementSchema = z.strictObject({
  id,
  courseId: id,
  title: z.string(),
  htmlUrl: z.url(),
  postedAt: z.string().nullable(),
  ...document,
});
export const canvasPageSchema = z.strictObject({
  id,
  courseId: id,
  slug: z.string(),
  title: z.string(),
  htmlUrl: z.url(),
  frontPage: z.boolean().nullable(),
  lockedForUser: z.boolean().nullable(),
  lockExplanation: z.string().nullable(),
  ...document,
});
const availability = z.enum(["available", "unavailable", "unknown"]);
export const canvasModuleSchema = z.strictObject({
  id,
  courseId: id,
  name: z.string(),
  position: z.number().nullable(),
  prerequisiteModuleIds: z.array(id).nullable(),
  requireSequentialProgress: z.boolean().nullable(),
  state: z.string().nullable(),
  unlockAt: z.string().nullable(),
  itemsCount: z.number().int().nonnegative().nullable(),
  htmlUrl: z.url(),
});
export const canvasModuleItemSchema = z.strictObject({
  id,
  courseId: id,
  moduleId: id,
  title: z.string(),
  type: z.string(),
  position: z.number().nullable(),
  contentId: id.nullable(),
  pageSlug: z.string().nullable(),
  htmlUrl: z.url(),
  lockedForUser: z.boolean().nullable(),
  completionRequirement: z
    .strictObject({
      type: z.string(),
      minScore: z.number().nullable(),
      completed: z.boolean().nullable(),
    })
    .nullable(),
  availability,
});
export const canvasFileSchema = z.strictObject({
  id,
  courseId: id,
  displayName: z.string(),
  filename: z.string().nullable(),
  size: z.number().nonnegative().nullable(),
  contentType: z.string().nullable(),
  locked: z.boolean().nullable(),
  lockedForUser: z.boolean().nullable(),
  hidden: z.boolean().nullable(),
  hiddenForUser: z.boolean().nullable(),
  lockExplanation: z.string().nullable(),
  lockAt: z.string().nullable(),
  unlockAt: z.string().nullable(),
  htmlUrl: z.url(),
  availability,
});
const sources = z.array(canvasCourseSourceSchema);
const continuation = z
  .string()
  .regex(/^[A-Za-z0-9_-]{32}$/u)
  .optional();
export const canvasSyllabusResponseSchema = z.strictObject({
  syllabus: canvasSyllabusSchema,
  sources,
});
export const canvasAnnouncementsSchema = z.strictObject({
  announcements: z.array(canvasAnnouncementSchema).max(100),
  sources,
  continuation,
});
export const canvasPagesSchema = z.strictObject({
  pages: z.array(canvasPageSchema).max(100),
  sources,
  continuation,
});
export const canvasPageResponseSchema = z.strictObject({ page: canvasPageSchema, sources });
export const canvasModulesSchema = z.strictObject({
  modules: z.array(canvasModuleSchema).max(100),
  sources,
  continuation,
});
export const canvasModuleItemsSchema = z.strictObject({
  module: canvasModuleSchema,
  items: z.array(canvasModuleItemSchema).max(100),
  sources,
  continuation,
});
export const canvasFilesSchema = z.strictObject({
  files: z.array(canvasFileSchema).max(100),
  sources,
  continuation,
});
export const canvasFileResponseSchema = z.strictObject({ file: canvasFileSchema, sources });

export type CanvasSyllabusQuery = z.output<typeof canvasSyllabusQuerySchema>;
export type CanvasAnnouncementsQuery = z.output<typeof canvasAnnouncementsQuerySchema>;
export type CanvasPagesQuery = z.output<typeof canvasPagesQuerySchema>;
export type CanvasPageQuery = z.output<typeof canvasPageQuerySchema>;
export type CanvasModulesQuery = z.output<typeof canvasModulesQuerySchema>;
export type CanvasModuleItemsQuery = z.output<typeof canvasModuleItemsQuerySchema>;
export type CanvasFilesQuery = z.output<typeof canvasFilesQuerySchema>;
export type CanvasFileQuery = z.output<typeof canvasFileQuerySchema>;
export type CanvasSyllabus = z.output<typeof canvasSyllabusSchema>;
export type CanvasAnnouncement = z.output<typeof canvasAnnouncementSchema>;
export type CanvasPage = z.output<typeof canvasPageSchema>;
export type CanvasModule = z.output<typeof canvasModuleSchema>;
export type CanvasModuleItem = z.output<typeof canvasModuleItemSchema>;
export type CanvasFile = z.output<typeof canvasFileSchema>;
export type CanvasSyllabusResponse = z.output<typeof canvasSyllabusResponseSchema>;
export type CanvasAnnouncementsResponse = z.output<typeof canvasAnnouncementsSchema>;
export type CanvasPagesResponse = z.output<typeof canvasPagesSchema>;
export type CanvasPageResponse = z.output<typeof canvasPageResponseSchema>;
export type CanvasModulesResponse = z.output<typeof canvasModulesSchema>;
export type CanvasModuleItemsResponse = z.output<typeof canvasModuleItemsSchema>;
export type CanvasFilesResponse = z.output<typeof canvasFilesSchema>;
export type CanvasFileResponse = z.output<typeof canvasFileResponseSchema>;
