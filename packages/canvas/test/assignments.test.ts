import assert from "node:assert/strict";
import test from "node:test";

import {
  createCanvasAssignmentWorkflows,
  createCanvasConnection,
  CanvasConnectionError,
} from "../src/index.js";

const context = { caller: "owner" };
const assignment = {
  id: "7",
  course_id: "1",
  name: "Synthetic geology",
  due_at: null,
  description: "<h1>Instructions</h1><script>privateScript()</script><p>Study rocks.</p>",
  submission_types: ["external_tool"],
  rubric: [],
  overrides: [],
};
function fixture(override?: (url: URL) => Response | undefined) {
  const state = {
    token: "synthetic",
    member: true,
    assignment: { ...assignment },
    submission: {
      assignment_id: "7",
      user_id: "123",
      workflow_state: "unsubmitted",
      posted_at: null as string | null | undefined,
      hidden: undefined as boolean | undefined,
      score: 0 as number | null,
      grade: "0" as string | null,
      missing: false,
      late: false,
      excused: false,
    },
    enrollments: [
      {
        id: "9",
        course_id: "1",
        user_id: "123",
        type: "StudentEnrollment",
        enrollment_state: "active",
        grades: { current_score: 0 as number | null, final_score: null, current_grade: null },
      },
    ],
  };
  const paths: string[] = [];
  const workflows = createCanvasAssignmentWorkflows(
    createCanvasConnection({
      userId: "123",
      loadCredential: () => Promise.resolve(state.token),
      fetch: (input) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        paths.push(url.pathname);
        const overridden = override?.(url);
        if (overridden) return Promise.resolve(overridden);
        if (url.pathname === "/api/v1/users/self")
          return Promise.resolve(Response.json({ id: "123" }));
        if (url.pathname === "/api/v1/users/self/enrollments")
          return Promise.resolve(Response.json(state.member ? state.enrollments : []));
        if (url.pathname === "/api/v1/courses/1")
          return Promise.resolve(Response.json({ id: "1", name: "Synthetic course" }));
        if (url.pathname === "/api/v1/courses/1/assignments")
          return Promise.resolve(
            Response.json([state.assignment, { ...state.assignment, id: "8" }]),
          );
        if (url.pathname === "/api/v1/courses/1/assignments/7")
          return Promise.resolve(Response.json(state.assignment));
        if (url.pathname === "/api/v1/courses/1/assignments/7/submissions/self")
          return Promise.resolve(Response.json(state.submission));
        if (url.pathname === "/api/v1/courses/1/enrollments")
          return Promise.resolve(Response.json(state.enrollments));
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    }),
    { userId: "123" },
  );
  return { state, paths, workflows };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof CanvasConnectionError && error.code === expected;

await test("assignment facts preserve null deadline and includes, safely converting instructions", async () => {
  const f = fixture();
  const result = await f.workflows.get({ courseId: "1", assignmentId: "7" }, context);
  assert.equal(result.assignment.dueAt, null);
  assert.deepEqual(result.assignment.submissionTypes, ["external_tool"]);
  assert.deepEqual(result.assignment.includes, {
    visibility: "absent",
    submission: "absent",
    rubric: "included",
    overrides: "included",
  });
  assert.match(result.assignment.instructions?.text ?? "", /Study rocks/);
  assert.ok(!result.assignment.instructions?.text.includes("privateScript"));
  assert.equal(result.assignment.instructions?.trust, "untrusted");
  assert.equal(f.paths.filter((path) => path === "/api/v1/users/self").length, 1);
});

await test("instruction continuation is bound to the actual converted document", async () => {
  const f = fixture();
  f.state.assignment.description = "<p>" + "Long instructions. ".repeat(300) + "</p>";
  const first = await f.workflows.get({ courseId: "1", assignmentId: "7" }, context);
  const continuation = first.assignment.instructions?.continuation;
  assert.ok(continuation);
  const next = await f.workflows.get(
    {
      courseId: "1",
      assignmentId: "7",
      instructionDocumentId: continuation.documentId,
      instructionOffset: continuation.offset,
    },
    context,
  );
  assert.equal(next.assignment.instructions?.offset, 1500);
  await assert.rejects(
    f.workflows.get(
      {
        courseId: "1",
        assignmentId: "7",
        instructionDocumentId: "a".repeat(64),
        instructionOffset: 1500,
      },
      context,
    ),
    code("CANVAS_INVALID_CURSOR"),
  );
});

await test("bounded assignment continuation rechecks membership, filters, caller and generation", async () => {
  const f = fixture();
  const first = await f.workflows.list({ courseId: "1", limit: 1 }, context);
  assert.equal(first.assignments[0]?.id, "7");
  assert.ok(first.continuation);
  assert.equal(first.sources.at(-1)?.coverage, "partial");
  await assert.rejects(
    f.workflows.list({ courseId: "1", limit: 2, cursor: first.continuation }, context),
    code("CANVAS_INVALID_CURSOR"),
  );
  await assert.rejects(
    f.workflows.list({ courseId: "1", limit: 1, cursor: first.continuation }, { caller: "other" }),
    code("CANVAS_INVALID_CURSOR"),
  );
  f.state.member = false;
  await assert.rejects(
    f.workflows.list({ courseId: "1", limit: 1, cursor: first.continuation }, context),
    code("CANVAS_COURSE_FORBIDDEN"),
  );
  f.state.member = true;
  const next = await f.workflows.list(
    { courseId: "1", limit: 1, cursor: first.continuation },
    context,
  );
  assert.equal(next.assignments[0]?.id, "8");
  assert.equal(next.continuation, undefined);
  const page = await f.workflows.list({ courseId: "1", limit: 1 }, context);
  f.state.token = "replacement";
  await assert.rejects(
    f.workflows.list({ courseId: "1", limit: 1, cursor: page.continuation }, context),
    code("CANVAS_INVALID_CURSOR"),
  );
});

await test("own submission evidence preserves external-tool ambiguity and suppresses unposted grades", async () => {
  const f = fixture();
  const hidden = await f.workflows.submission({ courseId: "1", assignmentId: "7" }, context);
  assert.equal(hidden.submission.workflowState, "unsubmitted");
  assert.equal(hidden.submission.missing, false);
  assert.equal(hidden.submission.gradeVisibility, "hidden");
  assert.ok(!("score" in hidden.submission));
  f.state.submission.posted_at = "2026-11-01T00:00:00Z";
  const visible = await f.workflows.submission(
    { courseId: "1", assignmentId: "7", fresh: true },
    context,
  );
  assert.equal(visible.submission.score, 0);
  assert.equal(visible.submission.grade, "0");
  f.state.submission.user_id = "456";
  await assert.rejects(
    f.workflows.submission({ courseId: "1", assignmentId: "7", fresh: true }, context),
    code("CANVAS_INVALID_RESPONSE"),
  );
});

await test("visible grades retain current/final zero/null/absent and ignore other users", async () => {
  const f = fixture();
  f.state.enrollments.push({ ...f.state.enrollments[0]!, user_id: "456" });
  const result = await f.workflows.grades({ courseId: "1", gradingPeriodId: "22" }, context);
  assert.equal(result.grades.length, 1);
  assert.deepEqual(result.grades[0]?.grades, {
    currentScore: 0,
    finalScore: null,
    currentGrade: null,
  });
  assert.equal(result.grades[0]?.gradingPeriodId, "22");
  assert.ok(!("finalGrade" in result.grades[0].grades));
});

await test("forbidden coursework does not reach assignment or submission resources", async () => {
  const f = fixture();
  f.state.member = false;
  await assert.rejects(
    f.workflows.get({ courseId: "1", assignmentId: "7" }, context),
    code("CANVAS_COURSE_FORBIDDEN"),
  );
  await assert.rejects(
    f.workflows.submission({ courseId: "1", assignmentId: "7" }, context),
    code("CANVAS_COURSE_FORBIDDEN"),
  );
  assert.ok(!f.paths.some((path) => path.includes("assignments")));
});

await test("null ungraded, absent posting, excused, and explicitly hidden grades stay distinct", async () => {
  const f = fixture();
  f.state.submission.score = null;
  f.state.submission.grade = null;
  const ungraded = await f.workflows.submission({ courseId: "1", assignmentId: "7" }, context);
  assert.equal(ungraded.submission.gradeVisibility, "ungraded");
  assert.equal(ungraded.submission.score, null);
  assert.equal(ungraded.submission.grade, null);
  f.state.submission.excused = true;
  const excused = await f.workflows.submission(
    { courseId: "1", assignmentId: "7", fresh: true },
    context,
  );
  assert.equal(excused.submission.excused, true);
  f.state.submission.score = 0;
  f.state.submission.grade = "0";
  f.state.submission.posted_at = undefined;
  const unknown = await f.workflows.submission(
    { courseId: "1", assignmentId: "7", fresh: true },
    context,
  );
  assert.equal(unknown.submission.gradeVisibility, "unknown");
  assert.ok(!("score" in unknown.submission));
  f.state.submission.hidden = true;
  f.state.submission.posted_at = "2026-11-01T00:00:00Z";
  const hidden = await f.workflows.submission(
    { courseId: "1", assignmentId: "7", fresh: true },
    context,
  );
  assert.equal(hidden.submission.gradeVisibility, "hidden");
  assert.ok(!("score" in hidden.submission));
});

await test("upstream assignment page two preserves personal dates, rubric associations, and absent includes", async () => {
  const deadline = "2026-11-12T04:30:00Z";
  const f = fixture((url) => {
    if (url.pathname !== "/api/v1/courses/1/assignments") return undefined;
    assert.equal(url.searchParams.get("override_assignment_dates"), "true");
    if (url.searchParams.get("page") === "2")
      return Response.json([
        {
          id: "8",
          course_id: "1",
          name: "Personal deadline",
          due_at: deadline,
          lock_at: null,
          unlock_at: "2026-11-01T00:00:00Z",
          rubric: [{ id: "criterion", points: 5 }],
          rubric_settings: { id: "12", title: "Rubric", use_for_grading: true },
          has_overrides: true,
          assignment_visibility: ["123"],
          overrides: [{ id: "11", student_ids: ["123"], due_at: deadline }],
        },
      ]);
    const next = new URL(url);
    next.searchParams.set("page", "2");
    return Response.json([assignment], { headers: { link: `<${next.href}>; rel="next"` } });
  });
  const first = await f.workflows.list({ courseId: "1" }, context);
  assert.ok(first.continuation);
  assert.equal(first.assignments.length, 1);
  const second = await f.workflows.list({ courseId: "1", cursor: first.continuation }, context);
  assert.equal(second.continuation, undefined);
  const personal = second.assignments[0];
  assert.equal(personal?.dueAt, deadline);
  assert.equal(personal.lockAt, null);
  assert.equal(personal.unlockAt, "2026-11-01T00:00:00Z");
  assert.deepEqual(personal.assignmentVisibility, ["123"]);
  assert.equal(personal.rubricSettings?.id, "12");
  assert.equal(personal.includes.visibility, "included");
  assert.equal(personal.instructionsAvailability, "absent");
  assert.equal(personal.includes.submission, "absent");
  assert.ok(second.sources.every((source) => source.coverage === "complete"));
});

await test("visible grade enrollment pagination retains self and grading period selectors", async () => {
  let pages = 0;
  const f = fixture((url) => {
    if (url.pathname !== "/api/v1/courses/1/enrollments") return undefined;
    pages++;
    assert.equal(url.searchParams.get("user_id"), "self");
    assert.equal(url.searchParams.get("grading_period_id"), "22");
    if (url.searchParams.get("page") === "2")
      return Response.json([
        {
          id: "10",
          course_id: "1",
          user_id: "123",
          type: "StudentEnrollment",
          enrollment_state: "active",
          grades: { current_score: 0, final_grade: null },
        },
        {
          id: "11",
          course_id: "1",
          user_id: "456",
          type: "StudentEnrollment",
          enrollment_state: "active",
          grades: { current_score: 100 },
        },
      ]);
    const next = new URL(url);
    next.searchParams.set("page", "2");
    return Response.json(
      [
        {
          id: "9",
          course_id: "1",
          user_id: "123",
          type: "StudentEnrollment",
          enrollment_state: "active",
        },
      ],
      { headers: { link: `<${next.href}>; rel="next"` } },
    );
  });
  const result = await f.workflows.grades({ courseId: "1", gradingPeriodId: "22" }, context);
  assert.equal(pages, 2);
  assert.deepEqual(
    result.grades.map((row) => row.enrollmentId),
    ["9", "10"],
  );
  assert.equal(result.grades[0]?.gradeVisibility, "absent");
  assert.equal(result.grades[0]?.grades, null);
  assert.deepEqual(result.grades[1]?.grades, { currentScore: 0, finalGrade: null });
  assert.ok(result.sources.every((source) => source.coverage === "complete"));
});

await test("visible grade pagination rejects widened user selectors without requesting them", async () => {
  let pages = 0;
  const f = fixture((url) => {
    if (url.pathname !== "/api/v1/courses/1/enrollments") return undefined;
    pages++;
    const next = new URL(url);
    next.searchParams.set("page", "2");
    next.searchParams.set("user_id", "456");
    return Response.json([], { headers: { link: `<${next.href}>; rel="next"` } });
  });
  await assert.rejects(
    f.workflows.grades({ courseId: "1" }, context),
    code("CANVAS_UNSAFE_PAGINATION"),
  );
  assert.equal(pages, 1);
});

for (const [label, oversized] of [
  ["large declared rubric", { rubric: [{ id: "criterion", description: "r".repeat(24000) }] }],
  ["15 KiB assignment name", { name: "n".repeat(15 * 1024) }],
  ["converter input limit", { description: `<p>${"x".repeat(270000)}</p>` }],
  ["converter complexity limit", { description: "<p>x</p>".repeat(5000) }],
] as const) {
  await test(`list progression survives ${label} without losing the following assignment`, async () => {
    const f = fixture((url) =>
      url.pathname === "/api/v1/courses/1/assignments"
        ? Response.json([
            { ...assignment, due_at: "2026-11-12T04:30:00Z", lock_at: null, ...oversized },
            { ...assignment, id: "8" },
          ])
        : undefined,
    );
    const first = await f.workflows.list({ courseId: "1", limit: 1 }, context);
    const compact = first.assignments[0];
    assert.equal(compact?.id, "7");
    assert.equal(compact.dueAt, "2026-11-12T04:30:00Z");
    assert.equal(compact.lockAt, null);
    assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 8 * 1024);
    assert.ok(compact.warnings.length > 0);
    if (label === "large declared rubric") {
      assert.deepEqual(compact.omittedFields, ["rubric"]);
      assert.equal(compact.includes.rubric, "included");
      assert.ok(!("rubric" in compact));
    } else if (label === "15 KiB assignment name") {
      assert.deepEqual(compact.omittedFields, ["name"]);
      assert.equal(compact.name, "");
    } else {
      assert.deepEqual(compact.omittedFields, ["instructions"]);
      assert.equal(compact.instructionsAvailability, "unavailable");
      assert.equal(compact.instructions, null);
      assert.match(compact.warnings[0] ?? "", /^DOCUMENT_TEXT_/u);
    }
    assert.ok(first.continuation);
    const last = await f.workflows.list(
      { courseId: "1", limit: 1, cursor: first.continuation },
      context,
    );
    assert.deepEqual(
      last.assignments.map((row) => row.id),
      ["8"],
    );
    assert.equal(last.continuation, undefined);
  });
}

await test("declared associations fitting the result budget retain their full metadata", async () => {
  const description = "r".repeat(10000);
  const f = fixture((url) =>
    url.pathname === "/api/v1/courses/1/assignments"
      ? Response.json([{ ...assignment, rubric: [{ id: "criterion", description }] }])
      : undefined,
  );
  const result = await f.workflows.list({ courseId: "1" }, context);
  assert.equal(result.assignments[0]?.rubric?.[0]?.description, description);
  assert.deepEqual(result.assignments[0]?.omittedFields, []);
  assert.deepEqual(result.assignments[0]?.warnings, []);
});

await test("unknown nested association fields do not escape through list or detail", async () => {
  const row = {
    ...assignment,
    rubric: [
      { id: "criterion", description: "Declared rubric", private_passthrough: "x".repeat(24000) },
    ],
    rubric_settings: {
      id: "9",
      title: "Declared rubric settings",
      private_passthrough: "private-value",
    },
    overrides: [{ id: "10", due_at: null, private_passthrough: "private-value" }],
    all_dates: [{ base: true, due_at: null, private_passthrough: "private-value" }],
  };
  const f = fixture((url) =>
    url.pathname === "/api/v1/courses/1/assignments"
      ? Response.json([row])
      : url.pathname === "/api/v1/courses/1/assignments/7"
        ? Response.json(row)
        : undefined,
  );
  const list = await f.workflows.list({ courseId: "1" }, context);
  const detail = await f.workflows.get({ courseId: "1", assignmentId: "7" }, context);
  for (const item of [list.assignments[0], detail.assignment]) {
    assert.ok(item);
    assert.ok(!JSON.stringify(item).includes("private_passthrough"));
    assert.equal(item.rubric?.[0]?.description, "Declared rubric");
    assert.equal(item.rubricSettings?.title, "Declared rubric settings");
    assert.deepEqual(item.omittedFields, []);
  }
});

await test("converter failure remains explicit in detail and does not mask invalid document continuation", async () => {
  const f = fixture();
  f.state.assignment.description = `<p>${"x".repeat(270000)}</p>`;
  await assert.rejects(
    f.workflows.get({ courseId: "1", assignmentId: "7" }, context),
    code("CANVAS_BUDGET_EXHAUSTED"),
  );
  f.state.assignment.description = "<p>Short document</p>";
  await assert.rejects(
    f.workflows.get(
      {
        courseId: "1",
        assignmentId: "7",
        fresh: true,
        instructionDocumentId: "a".repeat(64),
        instructionOffset: 1,
      },
      context,
    ),
    code("CANVAS_INVALID_CURSOR"),
  );
});
