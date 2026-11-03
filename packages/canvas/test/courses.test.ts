import assert from "node:assert/strict";
import test from "node:test";

import {
  CanvasConnectionError,
  createCanvasConnection,
  createCanvasCourseWorkflows,
} from "../src/index.js";

const caller = { caller: "owner" };
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Course ${id}`,
  course_code: `CODE ${id}`,
  workflow_state: "available",
  ...extra,
});
const enrollment = (courseId: string, extra: Record<string, unknown> = {}) => ({
  course_id: courseId,
  user_id: "123",
  type: "StudentEnrollment",
  enrollment_state: "active",
  ...extra,
});
function fixture(handler: (url: URL) => Response | Promise<Response>) {
  const requests: URL[] = [];
  let token = "fixture-token";
  const connection = createCanvasConnection({
    userId: "123",
    loadCredential: () => Promise.resolve(token),
    fetch: async (input) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      requests.push(url);
      if (url.pathname === "/api/v1/users/self") return Response.json({ id: "123" });
      return handler(url);
    },
  });
  return {
    courses: createCanvasCourseWorkflows(connection, {
      userId: "123",
      timeZone: "America/Phoenix",
    }),
    requests,
    rotate: () => {
      token = "rotated-token";
    },
  };
}
const isEnrollments = (url: URL) => url.pathname === "/api/v1/users/self/enrollments";
function expectCode(code: string) {
  return (error: unknown) => error instanceof CanvasConnectionError && error.code === code;
}

await test("list exposes only independently verified own student courses and normalized metadata", async () => {
  const huge = "90071992547409931234";
  const f = fixture((url) =>
    isEnrollments(url)
      ? Response.json([
          enrollment(huge),
          enrollment("2", { type: "TeacherEnrollment" }),
          enrollment("3", { user_id: "456" }),
          enrollment("4", { enrollment_state: "invited" }),
        ])
      : Response.json([row(huge), row("2"), row("3"), row("4"), row("5")]),
  );
  const result = await f.courses.list({}, caller);
  assert.deepEqual(result.courses, [
    {
      id: huge,
      name: `Course ${huge}`,
      courseCode: `CODE ${huge}`,
      workflowState: "available",
      timeZone: null,
      effectiveTimeZone: "America/Phoenix",
      timeZoneSource: "configured",
      htmlUrl: `https://learn.maricopa.edu/courses/${huge}`,
      enrollmentState: "active",
    },
  ]);
  assert.ok(
    result.sources.every((source) => source.coverage === "complete" && !("data" in source)),
  );
  assert.deepEqual(f.requests[1]?.searchParams.getAll("state[]"), ["active"]);
  assert.equal(f.requests.filter((url) => url.pathname === "/api/v1/users/self").length, 1);
});

await test("get denies supplied course IDs before requesting them and honors explicit concluded access", async () => {
  const f = fixture((url) =>
    isEnrollments(url)
      ? Response.json([enrollment("1", { enrollment_state: "completed" })])
      : Response.json(
          row("1", {
            workflow_state: "completed",
            time_zone: "America/New_York",
            enrollments: null,
          }),
        ),
  );
  await assert.rejects(
    f.courses.get({ courseId: "1" }, caller),
    expectCode("CANVAS_COURSE_FORBIDDEN"),
  );
  assert.ok(!f.requests.some((url) => url.pathname === "/api/v1/courses/1"));
  const result = await f.courses.get({ courseId: "1", concluded: true }, caller);
  assert.equal(result.course.enrollmentState, "completed");
  assert.equal(result.course.effectiveTimeZone, "America/New_York");
  assert.equal(result.course.timeZoneSource, "course");
  assert.ok(f.requests.some((url) => url.searchParams.getAll("state[]").includes("completed")));
  assert.ok(f.requests.every((url) => !url.searchParams.has("include[]")));
});

await test("empty enrollments stay empty and a revoked membership defeats cached course facts", async () => {
  let enrolled = true;
  const f = fixture((url) =>
    isEnrollments(url)
      ? Response.json(enrolled ? [enrollment("1")] : [])
      : Response.json(url.pathname.endsWith("/1") ? row("1") : [row("1")]),
  );
  await f.courses.get({ courseId: "1" }, caller);
  enrolled = false;
  await assert.rejects(
    f.courses.get({ courseId: "1" }, caller),
    expectCode("CANVAS_COURSE_FORBIDDEN"),
  );
  assert.deepEqual((await f.courses.list({}, caller)).courses, []);
});

await test("incomplete or unavailable enrollment verification cannot authorize course reads", async () => {
  for (const response of [
    () => new Response(null, { status: 403 }),
    () => Response.json([{ ...enrollment("1"), enrollment_state: undefined }]),
    () =>
      Response.json([enrollment("1")], {
        headers: { link: '<https://evil.example/>; rel="next"' },
      }),
  ]) {
    const f = fixture((url) => (isEnrollments(url) ? response() : Response.json(row("1"))));
    await assert.rejects(
      f.courses.get({ courseId: "1" }, caller),
      (error: unknown) => error instanceof CanvasConnectionError,
    );
    assert.ok(!f.requests.some((url) => url.pathname === "/api/v1/courses/1"));
  }
});

await test("bounded list continuation drains buffered facts, binds caller/filter, rechecks membership and rotates", async () => {
  let enrolled = [enrollment("1"), enrollment("2"), enrollment("3")];
  const f = fixture((url) =>
    isEnrollments(url) ? Response.json(enrolled) : Response.json([row("1"), row("2"), row("3")]),
  );
  const first = await f.courses.list({ limit: 1 }, caller);
  assert.equal(first.courses[0]?.id, "1");
  assert.equal(first.sources[1]?.coverage, "partial");
  assert.ok(first.continuation);
  await assert.rejects(
    f.courses.list({ limit: 1, cursor: first.continuation }, { caller: "other" }),
    expectCode("CANVAS_INVALID_CURSOR"),
  );
  await assert.rejects(
    f.courses.list({ limit: 2, cursor: first.continuation }, caller),
    expectCode("CANVAS_INVALID_CURSOR"),
  );
  enrolled = [enrollment("3")];
  const last = await f.courses.list({ limit: 1, cursor: first.continuation }, caller);
  assert.deepEqual(
    last.courses.map((course) => course.id),
    ["3"],
  );
  assert.equal(last.continuation, undefined);
  assert.equal(last.sources[1]?.coverage, "complete");
  await assert.rejects(
    f.courses.list({ limit: 1, cursor: first.continuation }, caller),
    expectCode("CANVAS_INVALID_CURSOR"),
  );
  enrolled = [enrollment("1"), enrollment("2"), enrollment("3")];
  const again = await f.courses.list({ limit: 1 }, caller);
  assert.ok(again.continuation);
  f.rotate();
  await assert.rejects(
    f.courses.list({ limit: 1, cursor: again.continuation }, caller),
    expectCode("CANVAS_INVALID_CURSOR"),
  );
});

await test("continuation traverses upstream pages without repeating courses", async () => {
  const f = fixture((url) => {
    if (isEnrollments(url)) return Response.json([enrollment("1"), enrollment("2")]);
    if (url.searchParams.has("page")) return Response.json([row("1"), row("2")]);
    const next = new URL(url);
    next.searchParams.set("page", "second");
    return Response.json([row("1")], { headers: { link: `<${next.href}>; rel="next"` } });
  });
  const first = await f.courses.list({}, caller);
  assert.ok(first.continuation);
  const second = await f.courses.list({ cursor: first.continuation }, caller);
  assert.deepEqual(
    second.courses.map((course) => course.id),
    ["2"],
  );
  assert.equal(second.continuation, undefined);
});

await test("single-resource failures and invalid metadata remain errors", async () => {
  for (const response of [
    () => new Response(null, { status: 404 }),
    () => Response.json(row("1", { time_zone: "invalid/timezone" })),
    () => Response.json(row("2")),
  ]) {
    const f = fixture((url) =>
      isEnrollments(url) ? Response.json([enrollment("1")]) : response(),
    );
    await assert.rejects(
      f.courses.get({ courseId: "1" }, caller),
      (error: unknown) => error instanceof CanvasConnectionError,
    );
  }
});

await test("buffered continuation refreshes enrollment state after membership changes", async () => {
  let completed = false;
  const f = fixture((url) => {
    if (isEnrollments(url))
      return Response.json([
        enrollment("1"),
        enrollment("2", { enrollment_state: completed ? "completed" : "active" }),
      ]);
    return Response.json(
      url.searchParams.get("enrollment_state") === "completed" ? [] : [row("1"), row("2")],
    );
  });
  const first = await f.courses.list({ concluded: true, limit: 1 }, caller);
  assert.ok(first.continuation);
  completed = true;
  const second = await f.courses.list(
    { concluded: true, limit: 1, cursor: first.continuation },
    caller,
  );
  assert.equal(second.courses[0]?.id, "2");
  assert.equal(second.courses[0]?.enrollmentState, "completed");
});

await test("course lists continue at the shared byte bound without dropping or truncating facts", async () => {
  const name = '\\"'.repeat(2500);
  const f = fixture((url) =>
    isEnrollments(url)
      ? Response.json([enrollment("1"), enrollment("2"), enrollment("3")])
      : Response.json([row("1", { name }), row("2", { name }), row("3", { name })]),
  );
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await f.courses.list({ cursor }, caller);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024);
    assert.ok(result.courses.length > 0 && result.courses.length < 3);
    for (const course of result.courses) {
      assert.equal(course.name, name);
      seen.push(course.id);
    }
    cursor = result.continuation;
    assert.equal(result.sources[1]?.coverage, cursor ? "partial" : "complete");
  } while (cursor);
  assert.deepEqual(seen, ["1", "2", "3"]);
});
