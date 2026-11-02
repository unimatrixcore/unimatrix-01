import { z } from "zod";

export const CANVAS_ORIGIN = "https://learn.maricopa.edu";

const id = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .max(128);
const date = z.iso.datetime({ offset: true }).or(z.iso.date());
const courseIds = z.array(id).min(1).max(100);
const window = { startDate: date, endDate: date };
const course = { courseId: id };
const assignment = { ...course, assignmentId: id };
const slug = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u);

const readSchema = z.discriminatedUnion("endpoint", [
  z.strictObject({ endpoint: z.literal("self") }),
  z.strictObject({ endpoint: z.literal("courses"), concluded: z.boolean().optional() }),
  z.strictObject({ endpoint: z.literal("course"), ...course }),
  z.strictObject({ endpoint: z.literal("assignments"), ...course }),
  z.strictObject({ endpoint: z.literal("assignment"), ...assignment }),
  z.strictObject({ endpoint: z.literal("submission"), ...assignment }),
  z.strictObject({ endpoint: z.literal("enrollments") }),
  z.strictObject({ endpoint: z.literal("planner"), ...window, courseIds: courseIds.optional() }),
  z.strictObject({
    endpoint: z.literal("calendar"),
    ...window,
    courseIds: courseIds.optional(),
    type: z.enum(["event", "assignment"]).optional(),
  }),
  z.strictObject({ endpoint: z.literal("missingSubmissions"), courseIds: courseIds.optional() }),
  z.strictObject({ endpoint: z.literal("announcements"), ...window, courseIds }),
  z.strictObject({ endpoint: z.literal("modules"), ...course }),
  z.strictObject({ endpoint: z.literal("moduleItems"), ...course, moduleId: id }),
  z.strictObject({ endpoint: z.literal("pages"), ...course }),
  z.strictObject({
    endpoint: z.literal("page"),
    ...course,
    selector: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("slug"), slug }),
      z.strictObject({ kind: z.literal("id"), pageId: id }),
      z.strictObject({ kind: z.literal("frontPage") }),
    ]),
  }),
  z.strictObject({ endpoint: z.literal("files"), ...course }),
  z.strictObject({ endpoint: z.literal("file"), ...course, fileId: id }),
]);

export type CanvasRead = z.infer<typeof readSchema>;

export interface CanvasEndpoint {
  url: URL;
  schema: z.ZodType;
  list: boolean;
  source: string;
}

const text = z.string();
const optionalId = id.nullable().optional();
const nullableText = text.nullable().optional();
const submissionSchema = z.looseObject({
  id: id.optional(),
  assignment_id: id,
  user_id: id,
  attempt: z.number().int().nonnegative().nullable().optional(),
  workflow_state: text,
  submitted_at: nullableText,
  grade: nullableText,
  score: z.number().nullable().optional(),
  missing: z.boolean().optional(),
  late: z.boolean().optional(),
  excused: z.boolean().nullable().optional(),
  grade_matches_current_submission: z.boolean().optional(),
});
const assignmentSchema = z.looseObject({
  id,
  course_id: id,
  name: text,
  description: nullableText,
  due_at: nullableText,
  lock_at: nullableText,
  unlock_at: nullableText,
  submission_types: z.array(text).optional(),
  points_possible: z.number().nullable().optional(),
  html_url: text.optional(),
  submission: submissionSchema.optional(),
});
const enrollmentSchema = z.looseObject({
  id: id.optional(),
  course_id: id,
  user_id: id,
  type: text,
  enrollment_state: text.optional(),
});
const courseSchema = z.looseObject({
  id,
  name: text.optional(),
  course_code: text.optional(),
  time_zone: text.optional(),
  syllabus_body: nullableText,
  enrollments: z.array(enrollmentSchema.omit({ course_id: true, user_id: true })).optional(),
});
const pageSchema = z.looseObject({
  page_id: id,
  url: text,
  title: text,
  body: nullableText,
  html_url: text.optional(),
});
const fileSchema = z.looseObject({
  id,
  display_name: text,
  filename: text.optional(),
  size: z.number().nonnegative().optional(),
  locked: z.boolean().optional(),
  locked_for_user: z.boolean().optional(),
});
const moduleItemSchema = z.looseObject({
  id,
  module_id: id,
  title: text,
  type: text,
  content_id: optionalId,
  page_url: text.optional(),
});
const moduleSchema = z.looseObject({
  id,
  name: text,
  items: z.array(moduleItemSchema).optional(),
  prerequisite_module_ids: z.array(id).optional(),
});
const plannerSchema = z.looseObject({
  plannable_id: id,
  plannable_type: text,
  course_id: optionalId,
  plannable_date: text,
  plannable: z.looseObject({ id }).optional(),
});
const calendarSchema = z.looseObject({
  id: z.string().min(1),
  title: text,
  start_at: nullableText,
  end_at: nullableText,
  assignment: assignmentSchema.optional(),
});
const announcementSchema = z.looseObject({
  id,
  title: text,
  message: nullableText,
  context_code: text.optional(),
});

function losslessIds(value: unknown, context: z.RefinementCtx, depth = 0): void {
  if (depth > 32) {
    context.addIssue({ code: "custom", message: "Canvas response nesting exceeds limit." });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) losslessIds(item, context, depth + 1);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if ((key === "id" || key.endsWith("_id")) && item !== null && typeof item !== "string") {
        context.addIssue({ code: "custom", message: "Canvas IDs must be strings." });
      }
      if (
        key.endsWith("_ids") &&
        item !== null &&
        (!Array.isArray(item) || item.some((entry: unknown) => typeof entry !== "string"))
      ) {
        context.addIssue({
          code: "custom",
          message: "Canvas ID collections must contain strings.",
        });
      }
      losslessIds(item, context, depth + 1);
    }
  }
}

export function buildEndpoint(input: CanvasRead): CanvasEndpoint {
  const read = readSchema.parse(input);
  let path: string;
  let schema: z.ZodType;
  let list = true;
  const query = new URLSearchParams();
  const addCourses = (ids: string[] | undefined, key = "context_codes[]") => {
    for (const value of ids ?? [])
      query.append(key, key === "context_codes[]" ? `course_${value}` : value);
  };
  switch (read.endpoint) {
    case "self":
      path = "/users/self";
      schema = z.looseObject({ id });
      list = false;
      break;
    case "courses":
      path = "/courses";
      schema = courseSchema;
      query.set("enrollment_type", "student");
      query.append("enrollment_state[]", "active");
      if (read.concluded) query.append("enrollment_state[]", "completed");
      break;
    case "course":
      path = `/courses/${read.courseId}`;
      schema = courseSchema;
      query.append("include[]", "syllabus_body");
      list = false;
      break;
    case "assignments":
      path = `/courses/${read.courseId}/assignments`;
      schema = assignmentSchema;
      break;
    case "assignment":
      path = `/courses/${read.courseId}/assignments/${read.assignmentId}`;
      schema = assignmentSchema;
      list = false;
      break;
    case "submission":
      path = `/courses/${read.courseId}/assignments/${read.assignmentId}/submissions/self`;
      schema = submissionSchema;
      list = false;
      break;
    case "enrollments":
      path = "/users/self/enrollments";
      schema = enrollmentSchema;
      query.append("type[]", "StudentEnrollment");
      break;
    case "planner":
      path = "/planner/items";
      schema = plannerSchema;
      query.set("start_date", read.startDate);
      query.set("end_date", read.endDate);
      addCourses(read.courseIds);
      break;
    case "calendar":
      path = "/calendar_events";
      schema = calendarSchema;
      query.set("start_date", read.startDate);
      query.set("end_date", read.endDate);
      query.set("type", read.type ?? "event");
      addCourses(read.courseIds);
      break;
    case "missingSubmissions":
      path = "/users/self/missing_submissions";
      schema = assignmentSchema;
      addCourses(read.courseIds, "course_ids[]");
      break;
    case "announcements":
      path = "/announcements";
      schema = announcementSchema;
      query.set("start_date", read.startDate);
      query.set("end_date", read.endDate);
      addCourses(read.courseIds);
      break;
    case "modules":
      path = `/courses/${read.courseId}/modules`;
      schema = moduleSchema;
      break;
    case "moduleItems":
      path = `/courses/${read.courseId}/modules/${read.moduleId}/items`;
      schema = moduleItemSchema;
      break;
    case "pages":
      path = `/courses/${read.courseId}/pages`;
      schema = pageSchema;
      break;
    case "page":
      path = `/courses/${read.courseId}/${read.selector.kind === "frontPage" ? "front_page" : `pages/${read.selector.kind === "id" ? `page_id:${read.selector.pageId}` : read.selector.slug}`}`;
      schema = pageSchema;
      list = false;
      break;
    case "files":
      path = `/courses/${read.courseId}/files`;
      schema = fileSchema;
      break;
    case "file":
      path = `/courses/${read.courseId}/files/${read.fileId}`;
      schema = fileSchema;
      list = false;
      break;
  }
  if ("startDate" in read && Date.parse(read.startDate) > Date.parse(read.endDate))
    throw new Error("Invalid Canvas date window.");
  if (list) query.set("per_page", "100");
  const url = new URL(`/api/v1${path}`, CANVAS_ORIGIN);
  url.search = query.toString();
  const responseSchema = list ? z.array(schema).max(1000) : schema;
  return {
    url,
    schema: z
      .unknown()
      .superRefine((value, context) => {
        losslessIds(value, context);
      })
      .pipe(responseSchema),
    list,
    source: url.toString(),
  };
}
