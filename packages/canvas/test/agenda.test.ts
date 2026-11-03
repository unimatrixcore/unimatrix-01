import assert from "node:assert/strict";
import test from "node:test";

import {
  createCanvasAgendaWorkflows,
  createCanvasConnection,
  CanvasConnectionError,
  type CanvasAgendaInput,
  type CanvasAgendaResult,
} from "../src/index.js";
const context = { caller: "owner" };
const query = { start: "2026-11-01", end: "2026-11-08", courseIds: ["1"] };
const assignment = {
  id: "7",
  course_id: "1",
  name: "Study",
  due_at: "2026-11-06T07:00:00Z",
  submission_types: ["online_upload"],
  submission: { assignment_id: "7", user_id: "123", workflow_state: "unsubmitted", missing: true },
};
function fixture(override?: (url: URL) => Response | undefined) {
  const urls: URL[] = [];
  const state = { token: "synthetic", member: true };
  const workflows = createCanvasAgendaWorkflows(
    createCanvasConnection({
      userId: "123",
      loadCredential: () => Promise.resolve(state.token),
      fetch: (input) =>
        Promise.resolve(
          (() => {
            const url = new URL(
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            );
            urls.push(url);
            const response = override?.(url);
            if (response) return response;
            if (url.pathname === "/api/v1/users/self") return Response.json({ id: "123" });
            if (url.pathname.endsWith("/enrollments"))
              return Response.json(
                state.member
                  ? [
                      {
                        course_id: "1",
                        user_id: "123",
                        type: "StudentEnrollment",
                        enrollment_state: "active",
                      },
                    ]
                  : [],
              );
            if (url.pathname.endsWith("/assignments/7")) return Response.json(assignment);
            return Response.json([]);
          })(),
        ),
    }),
    { userId: "123", timeZone: "America/Phoenix" },
  );
  return { workflows, urls, state };
}
async function collect(f: ReturnType<typeof fixture>, input: CanvasAgendaInput = query) {
  const pages: CanvasAgendaResult[] = [];
  let cursor: string | undefined;
  do {
    const result = await f.workflows.get({ ...input, ...(cursor ? { cursor } : {}) }, context);
    pages.push(result);
    cursor = result.continuation;
    assert.ok(pages.length < 30);
  } while (cursor);
  return { pages, result: pages.at(-1)!, items: pages.flatMap((page) => page.items) };
}
await test("deduplicates source evidence and retains planner completion independently of submission", async () => {
  const f = fixture((url) => {
    if (url.pathname.endsWith("/planner/items"))
      return Response.json([
        {
          plannable_id: "7",
          plannable_type: "assignment",
          course_id: "1",
          plannable_date: assignment.due_at,
          planner_override: { marked_complete: true, dismissed: true },
          plannable: { id: "7", title: "Study" },
        },
      ]);
    if (url.pathname.endsWith("/calendar_events"))
      return Response.json(
        url.searchParams.get("type") === "assignment"
          ? [{ id: "assignment_7", title: "Study", start_at: assignment.due_at, assignment }]
          : [
              {
                id: "9",
                title: "Lab",
                context_code: "course_1",
                all_day: true,
                all_day_date: "2026-11-05",
                start_at: null,
              },
            ],
      );
    if (url.pathname.endsWith("/missing_submissions")) return Response.json([assignment]);
    return undefined;
  });
  const { result, items } = await collect(f);
  assert.equal(result.coverage, "complete");
  assert.equal(result.nothingDue, false);
  assert.equal(items.length, 2);
  const item = items.find((item) => item.kind === "assignment")!;
  assert.equal(item.evidence.length, 4);
  assert.equal(item.evidence[0]?.completed, true);
  assert.equal(item.submission?.workflowState, "unsubmitted");
  assert.equal(item.submission?.missing, true);
  assert.equal(items.find((item) => item.kind === "event")?.allDayDate, "2026-11-05");
});
await test("page-two assignment and source coverage survive continuation without duplicate output", async () => {
  const f = fixture((url) => {
    if (!url.pathname.endsWith("/planner/items")) return undefined;
    if (url.searchParams.has("page"))
      return Response.json([
        {
          plannable_id: "7",
          plannable_type: "assignment",
          course_id: "1",
          plannable_date: assignment.due_at,
        },
      ]);
    const next = new URL(url);
    next.searchParams.set("page", "2");
    return Response.json([], { headers: { link: `<${next.href}>; rel="next"` } });
  });
  const { pages, items, result } = await collect(f);
  assert.ok(pages.length > 1);
  assert.equal(pages[0]?.nothingDue, null);
  assert.equal(items.length, 1);
  assert.equal(result.coverage, "complete");
});
await test("failed sources and forbidden discovery cannot claim nothing due", async () => {
  const f = fixture((url) =>
    url.pathname.endsWith("/calendar_events") ? new Response(null, { status: 403 }) : undefined,
  );
  const { result } = await collect(f);
  assert.equal(result.coverage, "partial");
  assert.equal(result.nothingDue, null);
  assert.ok(result.sources.some((source) => source.coverage === "unavailable"));
  await assert.rejects(
    f.workflows.get({ ...query, courseIds: ["2"] }, context),
    (error) => error instanceof CanvasConnectionError && error.code === "CANVAS_COURSE_FORBIDDEN",
  );
});
await test("timezone midnight boundaries cross daylight saving and timestamps remain original", async () => {
  const f = fixture();
  const { result } = await collect(f, {
    start: "2026-11-01",
    end: "2026-11-02",
    timeZone: "America/New_York",
    courseIds: ["1"],
  });
  assert.equal(result.effectiveTimeZone, "America/New_York");
  const planner = f.urls.find((url) => url.pathname.endsWith("/planner/items"))!;
  assert.equal(planner.searchParams.get("start_date"), "2026-11-01T04:00:00.000Z");
  assert.equal(planner.searchParams.get("end_date"), "2026-11-02T05:00:00.000Z");
  assert.equal(result.nothingDue, true);
});
await test("no-due missing work stays visible, external submissions remain ambiguous, and cursors are caller-bound", async () => {
  const noDue = {
    ...assignment,
    due_at: null,
    submission_types: ["external_tool"],
    submission: { ...assignment.submission, missing: false },
  };
  const f = fixture((url) =>
    url.pathname.endsWith("/missing_submissions")
      ? Response.json([noDue])
      : url.pathname.endsWith("/assignments/7")
        ? Response.json(noDue)
        : undefined,
  );
  const { items } = await collect(f);
  assert.equal(items[0]?.dueAt, null);
  assert.equal(items[0]?.overdue, null);
  const first = await f.workflows.get({ start: query.start, end: query.end }, context);
  assert.ok(first.continuation);
  await assert.rejects(
    f.workflows.get(
      { start: query.start, end: query.end, cursor: first.continuation },
      { caller: "other" },
    ),
    (error) => error instanceof CanvasConnectionError && error.code === "CANVAS_INVALID_CURSOR",
  );
  f.state.token = "rotated";
  await assert.rejects(
    f.workflows.get({ start: query.start, end: query.end, cursor: first.continuation }, context),
    (error) => error instanceof CanvasConnectionError && error.code === "CANVAS_INVALID_CURSOR",
  );
});

await test("timed events ignore all-day date metadata and retain overlapping intervals and notes", async () => {
  const f = fixture((url) => {
    if (url.pathname.endsWith("/calendar_events") && url.searchParams.get("type") === "event")
      return Response.json([
        {
          id: "a",
          title: "Timed",
          context_code: "course_1",
          start_at: "2026-11-03T15:00:00Z",
          end_at: "2026-11-03T16:00:00Z",
          all_day: false,
          all_day_date: "2026-11-03",
        },
        {
          id: "b",
          title: "Overlapping",
          context_code: "course_1",
          start_at: "2026-11-03T11:00:00Z",
          end_at: "2026-11-03T13:00:00Z",
        },
      ]);
    if (url.pathname.endsWith("/planner/items"))
      return Response.json([
        {
          plannable_id: "9",
          plannable_type: "planner_note",
          plannable_date: "2026-11-03T14:00:00Z",
          plannable: { id: "9", title: "Remember field notebook" },
        },
      ]);
    return undefined;
  });
  const { items, result } = await collect(f, {
    ...query,
    start: "2026-11-03T12:00:00Z",
    end: "2026-11-03T18:00:00Z",
  });
  assert.equal(items.length, 3);
  const timed = items.find((item) => item.title === "Timed");
  assert.equal(timed?.allDayDate, null);
  assert.equal(timed?.evidence[0]?.date, "2026-11-03T15:00:00Z");
  assert.equal(result.nothingDue, false);
  assert.deepEqual(
    items.map((item) => item.title),
    ["Overlapping", "Remember field notebook", "Timed"],
  );
});
await test("zone-resolved windows reject invalid ordering and elapsed budgets before upstream access", async () => {
  const f = fixture();
  for (const window of [
    { start: "2026-11-03", end: "2026-11-03T01:00:00Z", timeZone: "America/Phoenix" },
    { start: "2026-10-01", end: "2027-01-02", timeZone: "America/New_York" },
    { start: "2026-01-01", end: "2027-01-01", timeZone: "America/Phoenix" },
  ]) {
    await assert.rejects(
      f.workflows.get(window, context),
      (error) =>
        error instanceof CanvasConnectionError &&
        error.code === "CANVAS_INVALID_REQUEST" &&
        error.statusCode === 400,
    );
  }
  assert.equal(f.urls.length, 0);
  const valid = await collect(f, {
    ...query,
    start: "2026-10-01",
    end: "2027-01-02T04:00:00Z",
    timeZone: "America/New_York",
  });
  assert.equal(valid.result.coverage, "complete");
});
await test("calendar contexts are explicit and batched at ten while personal events remain separate", async () => {
  const f = fixture((url) =>
    url.pathname.endsWith("/enrollments")
      ? Response.json(
          Array.from({ length: 12 }, (_, index) => ({
            course_id: String(index + 1),
            user_id: "123",
            type: "StudentEnrollment",
            enrollment_state: "active",
          })),
        )
      : undefined,
  );
  const { result } = await collect(f, { start: query.start, end: query.end });
  assert.equal(result.coverage, "complete");
  const calendars = f.urls.filter((url) => url.pathname.endsWith("/calendar_events"));
  assert.ok(calendars.some((url) => url.searchParams.getAll("context_codes[]").length === 10));
  assert.ok(calendars.some((url) => url.searchParams.getAll("context_codes[]").length === 2));
  assert.ok(calendars.some((url) => !url.searchParams.has("context_codes[]")));
  assert.ok(calendars.every((url) => url.searchParams.getAll("context_codes[]").length <= 10));
});
await test("output pagination retains deduplication and rejects revoked enrollment", async () => {
  const f = fixture((url) =>
    url.pathname.endsWith("/calendar_events") && url.searchParams.get("type") === "event"
      ? Response.json([
          { id: "a", title: "a", context_code: "course_1", start_at: "2026-11-03T12:00:00Z" },
          { id: "b", title: "b", context_code: "course_1", start_at: "2026-11-04T12:00:00Z" },
        ])
      : undefined,
  );
  const { items } = await collect(f, { ...query, limit: 1 });
  assert.deepEqual(
    items.map((item) => item.title),
    ["a", "b"],
  );
  const first = await f.workflows.get({ ...query, limit: 1 }, context);
  assert.ok(first.continuation);
  f.state.member = false;
  await assert.rejects(
    f.workflows.get({ ...query, limit: 1, cursor: first.continuation }, context),
    (error) => error instanceof CanvasConnectionError && error.code === "CANVAS_COURSE_FORBIDDEN",
  );
});

await test("multi-day all-day events overlap a later requested day", async () => {
  const f = fixture((url) =>
    url.pathname.endsWith("/calendar_events") && url.searchParams.get("type") === "event"
      ? Response.json([
          {
            id: "trip",
            title: "Field trip",
            context_code: "course_1",
            start_at: "2026-11-01T07:00:00Z",
            end_at: "2026-11-05T07:00:00Z",
            all_day: true,
            all_day_date: "2026-11-01",
          },
        ])
      : undefined,
  );
  const { items, result } = await collect(f, { ...query, start: "2026-11-03", end: "2026-11-04" });
  assert.equal(items[0]?.allDayDate, "2026-11-01");
  assert.equal(result.nothingDue, false);
});
await test("failed hydration sources remain visible even when item is filtered out", async () => {
  const f = fixture((url) => {
    if (url.pathname.endsWith("/planner/items"))
      return Response.json([
        {
          plannable_id: "7",
          plannable_type: "assignment",
          course_id: "1",
          plannable_date: "2026-12-01T07:00:00Z",
        },
      ]);
    if (url.pathname.endsWith("/assignments/7")) return new Response(null, { status: 403 });
    return undefined;
  });
  const { result } = await collect(f);
  assert.equal(result.items.length, 0);
  assert.equal(result.coverage, "partial");
  assert.ok(
    result.sources.some(
      (source) => source.source.includes("/assignments/7") && source.coverage === "unavailable",
    ),
  );
});
