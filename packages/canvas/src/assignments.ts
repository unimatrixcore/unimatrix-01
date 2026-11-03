import { randomBytes } from "node:crypto";
import {
  convertHtmlDocument,
  DocumentTextError,
  type DocumentTextContinuation,
} from "@unimatrix/document-text";
import { z } from "zod";

import {
  createCanvasCourseWorkflows,
  type CanvasCourseContext,
  type CanvasCourseOptions,
  type CanvasCourseSource,
} from "./courses.js";
import {
  canvasAssignmentWireSchema,
  canvasSubmissionWireSchema,
  canvasEnrollmentWireSchema,
  CANVAS_ORIGIN,
  type CanvasRead,
} from "./endpoints.js";
import { CanvasConnectionError } from "./errors.js";
import type { CanvasConnection } from "./index.js";
import {
  createCanvasTransport,
  type CanvasSourceResult,
  type CanvasTransport,
} from "./transport.js";

const id = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .max(128);
const base = { courseId: id, concluded: z.boolean().optional(), fresh: z.boolean().optional() };
const detailInput = z.strictObject({
  ...base,
  assignmentId: id,
  instructionDocumentId: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  instructionOffset: z.number().int().positive().optional(),
});
const listInput = z.strictObject({
  ...base,
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32}$/u)
    .optional(),
});
const submissionInput = z.strictObject({ ...base, assignmentId: id });
const gradesInput = z.strictObject({ ...base, gradingPeriodId: id.optional() });
export interface CanvasAssignmentInput {
  courseId: string;
  assignmentId: string;
  concluded?: boolean | undefined;
  fresh?: boolean | undefined;
  instructionDocumentId?: string | undefined;
  instructionOffset?: number | undefined;
}
export interface CanvasAssignmentListInput {
  courseId: string;
  concluded?: boolean | undefined;
  fresh?: boolean | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}
export interface CanvasGradesInput {
  courseId: string;
  concluded?: boolean | undefined;
  fresh?: boolean | undefined;
  gradingPeriodId?: string | undefined;
}

function metadata(source: CanvasSourceResult): CanvasCourseSource {
  return {
    source: source.source,
    sourceLinks: source.sourceLinks,
    coverage: source.coverage,
    retrievedAt: source.retrievedAt,
    cacheAgeMs: source.cacheAgeMs,
    warnings: source.warnings,
  };
}
function source(result: { sources: CanvasSourceResult[] }): CanvasSourceResult {
  const value = result.sources[0];
  if (!value) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
  if (value.coverage === "unavailable" || value.coverage === "not_requested")
    throw new CanvasConnectionError(value.warnings[0] ?? "CANVAS_INVALID_RESPONSE");
  return value;
}
function bounded<T>(result: T): T {
  if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024)
    throw new CanvasConnectionError("CANVAS_BUDGET_EXHAUSTED");
  return result;
}
function normalize(
  value: unknown,
  courseId: string,
  continuation?: DocumentTextContinuation,
  list = false,
) {
  const row = canvasAssignmentWireSchema.parse(value);
  if (row.course_id !== courseId) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
  const htmlUrl = `${CANVAS_ORIGIN}/courses/${courseId}/assignments/${row.id}`;
  let instructions = null;
  let instructionsAvailability: "included" | "absent" | "unavailable" =
    row.description === undefined ? "absent" : "included";
  const omittedFields: string[] = [];
  const warnings: string[] = [];
  try {
    if (row.description !== undefined && row.description !== null)
      instructions = convertHtmlDocument({
        html: row.description,
        baseUrl: htmlUrl,
        maxOutputCharacters: 1500,
        ...(continuation === undefined ? {} : { continuation }),
      });
    else if (continuation) throw new CanvasConnectionError("CANVAS_INVALID_CURSOR");
  } catch (error) {
    if (!(error instanceof DocumentTextError)) throw error;
    if (!list || error.code === "invalid_continuation")
      throw new CanvasConnectionError(
        error.code === "invalid_continuation" ? "CANVAS_INVALID_CURSOR" : "CANVAS_BUDGET_EXHAUSTED",
      );
    instructionsAvailability = "unavailable";
    omittedFields.push("instructions");
    warnings.push(`DOCUMENT_TEXT_${error.code.toUpperCase()}`);
  }
  return {
    id: row.id,
    courseId,
    name: row.name,
    htmlUrl,
    ...(row.due_at === undefined ? {} : { dueAt: row.due_at }),
    ...(row.lock_at === undefined ? {} : { lockAt: row.lock_at }),
    ...(row.unlock_at === undefined ? {} : { unlockAt: row.unlock_at }),
    ...(row.submission_types === undefined ? {} : { submissionTypes: row.submission_types }),
    ...(row.points_possible === undefined ? {} : { pointsPossible: row.points_possible }),
    ...(row.published === undefined ? {} : { published: row.published }),
    ...(row.locked_for_user === undefined ? {} : { lockedForUser: row.locked_for_user }),
    ...(row.lock_explanation === undefined ? {} : { lockExplanation: row.lock_explanation }),
    ...(row.only_visible_to_overrides === undefined
      ? {}
      : { onlyVisibleToOverrides: row.only_visible_to_overrides }),
    ...(row.has_overrides === undefined ? {} : { hasOverrides: row.has_overrides }),
    ...(row.rubric === undefined ? {} : { rubric: row.rubric }),
    ...(row.rubric_settings === undefined ? {} : { rubricSettings: row.rubric_settings }),
    ...(row.overrides === undefined ? {} : { overrides: row.overrides }),
    ...(row.assignment_visibility === undefined
      ? {}
      : { assignmentVisibility: row.assignment_visibility }),
    ...(row.all_dates === undefined ? {} : { allDates: row.all_dates }),
    ...(row.use_rubric_for_grading === undefined
      ? {}
      : { useRubricForGrading: row.use_rubric_for_grading }),
    ...(row.grading_type === undefined ? {} : { gradingType: row.grading_type }),
    ...(row.omit_from_final_grade === undefined
      ? {}
      : { omitFromFinalGrade: row.omit_from_final_grade }),
    ...(row.hide_in_gradebook === undefined ? {} : { hideInGradebook: row.hide_in_gradebook }),
    instructions,
    instructionsAvailability,
    omittedFields,
    warnings,
    includes: {
      visibility:
        row.assignment_visibility === undefined ? ("absent" as const) : ("included" as const),
      submission: row.submission === undefined ? ("absent" as const) : ("included" as const),
      rubric: row.rubric === undefined ? ("absent" as const) : ("included" as const),
      overrides: row.overrides === undefined ? ("absent" as const) : ("included" as const),
    },
  };
}
export type CanvasAssignment = ReturnType<typeof normalize>;
function compactAssignment(assignment: CanvasAssignment): CanvasAssignment {
  const compact = {
    ...assignment,
    omittedFields: [...assignment.omittedFields],
    warnings: [...assignment.warnings],
  };
  const optionalFields = [
    "submissionTypes",
    "pointsPossible",
    "published",
    "lockedForUser",
    "lockExplanation",
    "onlyVisibleToOverrides",
    "hasOverrides",
    "rubric",
    "rubricSettings",
    "overrides",
    "assignmentVisibility",
    "allDates",
    "useRubricForGrading",
    "gradingType",
    "omitFromFinalGrade",
    "hideInGradebook",
  ] as const;
  const candidates = [...optionalFields, "instructions", "name"] as const;
  const largestFirst = [...candidates]
    .filter((field) => compact[field] !== undefined && compact[field] !== null)
    .sort(
      (left, right) =>
        Buffer.byteLength(JSON.stringify(compact[right])) -
        Buffer.byteLength(JSON.stringify(compact[left])),
    );
  for (const field of largestFirst) {
    if (Buffer.byteLength(JSON.stringify(compact)) <= 8 * 1024) break;
    if (field === "name") compact.name = "";
    else if (field === "instructions") {
      compact.instructions = null;
      compact.instructionsAvailability = "unavailable";
    } else delete compact[field];
    compact.omittedFields.push(field);
  }
  if (compact.omittedFields.length > assignment.omittedFields.length)
    compact.warnings.push("CANVAS_ASSIGNMENT_FIELDS_OMITTED");
  return compact;
}
function normalizeList(value: unknown, courseId: string): CanvasAssignment {
  const assignment = normalize(value, courseId, undefined, true);
  return assignment.instructionsAvailability === "unavailable"
    ? compactAssignment(assignment)
    : assignment;
}
export interface CanvasAssignmentListResult {
  assignments: CanvasAssignment[];
  sources: CanvasCourseSource[];
  continuation?: string;
}
export interface CanvasAssignmentResult {
  assignment: CanvasAssignment;
  sources: CanvasCourseSource[];
}
export interface CanvasSubmissionResult {
  courseId: string;
  assignmentId: string;
  submission: {
    workflowState: string;
    attempt?: number | null;
    submittedAt?: string | null;
    submissionType?: string | null;
    gradedAt?: string | null;
    cachedDueDate?: string | null;
    missing?: boolean;
    late?: boolean;
    excused?: boolean | null;
    gradeMatchesCurrentSubmission?: boolean;
    postedAt?: string | null;
    grade?: string | null;
    score?: number | null;
    gradeVisibility: "visible" | "hidden" | "unknown" | "ungraded";
  };
  sources: CanvasCourseSource[];
}
export interface CanvasGradesResult {
  grades: {
    courseId: string;
    enrollmentId: string | null;
    enrollmentState: string | null;
    gradingPeriodId: string | null;
    grades: {
      currentScore?: number | null;
      finalScore?: number | null;
      currentGrade?: string | null;
      finalGrade?: string | null;
    } | null;
    gradeVisibility: "reported" | "absent";
  }[];
  sources: CanvasCourseSource[];
}
export interface CanvasAssignmentWorkflows {
  list(
    input: CanvasAssignmentListInput,
    context: CanvasCourseContext,
  ): Promise<CanvasAssignmentListResult>;
  get(input: CanvasAssignmentInput, context: CanvasCourseContext): Promise<CanvasAssignmentResult>;
  submission(
    input: CanvasAssignmentInput,
    context: CanvasCourseContext,
  ): Promise<CanvasSubmissionResult>;
  grades(input: CanvasGradesInput, context: CanvasCourseContext): Promise<CanvasGradesResult>;
}
interface Cursor {
  key: string;
  generation: string;
  expires: number;
  pending: CanvasAssignment[];
  next?: string;
  source: CanvasCourseSource;
}

export function createCanvasAssignmentWorkflows(
  connection: CanvasConnection,
  options: CanvasCourseOptions,
): CanvasAssignmentWorkflows {
  const transport = createCanvasTransport(connection);
  const cursors = new Map<string, Cursor>();
  async function verify(
    scoped: CanvasTransport,
    input: CanvasGradesInput,
    context: CanvasCourseContext,
  ) {
    return createCanvasCourseWorkflows(connection, { ...options, transport: scoped }).get(
      {
        courseId: input.courseId,
        ...(input.concluded === undefined ? {} : { concluded: input.concluded }),
        ...(input.fresh === undefined ? {} : { fresh: input.fresh }),
      },
      context,
    );
  }
  async function read(
    scoped: CanvasTransport,
    endpoint: CanvasRead,
    context: CanvasCourseContext,
    fresh?: boolean,
  ) {
    return source(
      await scoped.read(endpoint, {
        ...context,
        maxPages: 18,
        ...(fresh === undefined ? {} : { fresh }),
      }),
    );
  }
  return {
    list: async (
      input: CanvasAssignmentListInput,
      context: CanvasCourseContext,
    ): Promise<CanvasAssignmentListResult> => {
      const query = listInput.parse(input);
      if (query.cursor && query.fresh) throw new CanvasConnectionError("CANVAS_INVALID_CURSOR");
      return transport.withSession(
        async (scoped, session) => {
          const now = Date.now();
          for (const [token, cursor] of cursors)
            if (cursor.expires <= now || cursor.generation !== session.generation)
              cursors.delete(token);
          const key = JSON.stringify([
            context.caller,
            query.courseId,
            query.concluded ?? false,
            query.limit,
          ]);
          const state = query.cursor ? cursors.get(query.cursor) : undefined;
          if (query.cursor && (!state || state.key !== key))
            throw new CanvasConnectionError("CANVAS_INVALID_CURSOR");
          const course = await verify(scoped, query, context);
          let pending = state?.pending ?? [];
          let next = state?.next;
          let origin = state?.source;
          if (!state || (!pending.length && next)) {
            const response = await scoped.read(
              { endpoint: "assignments", courseId: query.courseId },
              {
                ...context,
                maxPages: 1,
                ...(query.fresh === undefined ? {} : { fresh: query.fresh }),
                ...(next === undefined ? {} : { continuation: next }),
              },
            );
            const raw = source(response);
            pending = pending.concat(raw.data.map((value) => normalizeList(value, query.courseId)));
            next = response.continuation;
            origin = metadata(raw);
          }
          if (!origin) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
          const assignments: CanvasAssignment[] = [];
          const result: CanvasAssignmentListResult = {
            assignments,
            sources: [
              ...course.sources,
              {
                ...origin,
                cacheAgeMs:
                  origin.retrievedAt === null
                    ? 0
                    : Math.max(origin.cacheAgeMs, now - Date.parse(origin.retrievedAt)),
              },
            ],
          };
          for (const assignment of pending.slice(0, query.limit)) {
            assignments.push(assignment);
            if (Buffer.byteLength(JSON.stringify(result)) > 15 * 1024) {
              assignments.pop();
              if (assignments.length) break;
              assignments.push(compactAssignment(assignment));
            }
          }
          if (pending.length && !assignments.length)
            throw new CanvasConnectionError("CANVAS_BUDGET_EXHAUSTED");
          pending = pending.slice(assignments.length);
          if (query.cursor) cursors.delete(query.cursor);
          if (pending.length || next) {
            const token = randomBytes(24).toString("base64url");
            if (cursors.size >= 64) cursors.delete(cursors.keys().next().value ?? "");
            cursors.set(token, {
              key,
              generation: session.generation,
              expires: state?.expires ?? now + 300000,
              pending,
              source: origin,
              ...(next === undefined ? {} : { next }),
            });
            result.continuation = token;
            result.sources[result.sources.length - 1] = { ...origin, coverage: "partial" };
          }
          return bounded(result);
        },
        context.signal === undefined ? {} : { signal: context.signal },
      );
    },
    get: async (
      input: CanvasAssignmentInput,
      context: CanvasCourseContext,
    ): Promise<CanvasAssignmentResult> => {
      const query = detailInput.parse(input);
      if ((query.instructionDocumentId === undefined) !== (query.instructionOffset === undefined))
        throw new CanvasConnectionError("CANVAS_INVALID_CURSOR");
      return transport.withSession(
        async (scoped) => {
          const course = await verify(scoped, query, context);
          const raw = await read(
            scoped,
            { endpoint: "assignment", courseId: query.courseId, assignmentId: query.assignmentId },
            context,
            query.fresh,
          );
          const assignment = normalize(
            raw.data[0],
            query.courseId,
            query.instructionDocumentId === undefined || query.instructionOffset === undefined
              ? undefined
              : { documentId: query.instructionDocumentId, offset: query.instructionOffset },
          );
          if (assignment.id !== query.assignmentId)
            throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
          return bounded({ assignment, sources: [...course.sources, metadata(raw)] });
        },
        context.signal === undefined ? {} : { signal: context.signal },
      );
    },
    submission: async (input: CanvasAssignmentInput, context: CanvasCourseContext) => {
      const query = submissionInput.parse(input);
      return transport.withSession(
        async (scoped) => {
          const course = await verify(scoped, query, context);
          const raw = await read(
            scoped,
            { endpoint: "submission", courseId: query.courseId, assignmentId: query.assignmentId },
            context,
            query.fresh,
          );
          const row = canvasSubmissionWireSchema.parse(raw.data[0]);
          if (row.assignment_id !== query.assignmentId || row.user_id !== options.userId)
            throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
          const ungraded =
            row.hidden !== true &&
            row.workflow_state !== "graded" &&
            row.grade === null &&
            row.score === null;
          const visible = row.hidden !== true && typeof row.posted_at === "string";
          return bounded({
            courseId: query.courseId,
            assignmentId: query.assignmentId,
            submission: {
              workflowState: row.workflow_state,
              ...(row.attempt === undefined ? {} : { attempt: row.attempt }),
              ...(row.submitted_at === undefined ? {} : { submittedAt: row.submitted_at }),
              ...(row.missing === undefined ? {} : { missing: row.missing }),
              ...(row.late === undefined ? {} : { late: row.late }),
              ...(row.excused === undefined ? {} : { excused: row.excused }),
              ...(row.grade_matches_current_submission === undefined
                ? {}
                : { gradeMatchesCurrentSubmission: row.grade_matches_current_submission }),
              ...(row.posted_at === undefined ? {} : { postedAt: row.posted_at }),
              ...(row.submission_type === undefined ? {} : { submissionType: row.submission_type }),
              ...(row.graded_at === undefined ? {} : { gradedAt: row.graded_at }),
              ...(row.cached_due_date === undefined ? {} : { cachedDueDate: row.cached_due_date }),
              ...((visible || ungraded) && row.grade !== undefined ? { grade: row.grade } : {}),
              ...((visible || ungraded) && row.score !== undefined ? { score: row.score } : {}),
              gradeVisibility: ungraded
                ? ("ungraded" as const)
                : visible
                  ? ("visible" as const)
                  : row.hidden === true || row.posted_at === null
                    ? ("hidden" as const)
                    : ("unknown" as const),
            },
            sources: [...course.sources, metadata(raw)],
          });
        },
        context.signal === undefined ? {} : { signal: context.signal },
      );
    },
    grades: async (input: CanvasGradesInput, context: CanvasCourseContext) => {
      const query = gradesInput.parse(input);
      return transport.withSession(
        async (scoped) => {
          const course = await verify(scoped, query, context);
          const raw = await read(
            scoped,
            {
              endpoint: "courseEnrollments",
              courseId: query.courseId,
              ...(query.concluded === undefined ? {} : { concluded: query.concluded }),
              ...(query.gradingPeriodId === undefined
                ? {}
                : { gradingPeriodId: query.gradingPeriodId }),
            },
            context,
            query.fresh,
          );
          if (raw.coverage !== "complete")
            throw new CanvasConnectionError(raw.warnings[0] ?? "CANVAS_BUDGET_EXHAUSTED");
          const grades = raw.data
            .map((value) => canvasEnrollmentWireSchema.parse(value))
            .filter(
              (row) =>
                row.user_id === options.userId &&
                row.course_id === query.courseId &&
                row.type === "StudentEnrollment" &&
                (row.enrollment_state === "active" ||
                  (query.concluded === true && row.enrollment_state === "completed")),
            )
            .map((row) => ({
              courseId: query.courseId,
              enrollmentId: row.id ?? null,
              enrollmentState: row.enrollment_state ?? null,
              gradingPeriodId: query.gradingPeriodId ?? null,
              grades:
                row.grades == null
                  ? null
                  : {
                      ...(row.grades.current_grade === undefined
                        ? {}
                        : { currentGrade: row.grades.current_grade }),
                      ...(row.grades.final_grade === undefined
                        ? {}
                        : { finalGrade: row.grades.final_grade }),
                      ...(row.grades.current_score === undefined
                        ? {}
                        : { currentScore: row.grades.current_score }),
                      ...(row.grades.final_score === undefined
                        ? {}
                        : { finalScore: row.grades.final_score }),
                    },
              gradeVisibility:
                row.grades === undefined ? ("absent" as const) : ("reported" as const),
            }));
          return bounded({ grades, sources: [...course.sources, metadata(raw)] });
        },
        context.signal === undefined ? {} : { signal: context.signal },
      );
    },
  };
}
