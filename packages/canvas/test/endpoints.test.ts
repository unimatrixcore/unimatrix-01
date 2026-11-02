import assert from "node:assert/strict";
import test from "node:test";

import { buildEndpoint, type CanvasRead } from "../src/endpoints.js";

const huge = "90071992547409931234";

await test("endpoint reads keep large identifiers and fix origin and own-account selectors", () => {
  const submission = buildEndpoint({ endpoint: "submission", courseId: huge, assignmentId: huge });
  assert.equal(
    submission.url.href,
    `https://learn.maricopa.edu/api/v1/courses/${huge}/assignments/${huge}/submissions/self`,
  );
  assert.equal(submission.list, false);
  assert.equal(buildEndpoint({ endpoint: "self" }).url.pathname, "/api/v1/users/self");
  assert.equal(
    buildEndpoint({ endpoint: "enrollments" }).url.pathname,
    "/api/v1/users/self/enrollments",
  );
  const courses = buildEndpoint({ endpoint: "courses", concluded: true });
  assert.equal(courses.url.searchParams.get("enrollment_type"), "student");
  assert.deepEqual(courses.url.searchParams.getAll("enrollment_state[]"), ["active", "completed"]);
});

await test("page selectors distinguish numeric slugs from explicit IDs and the front page", () => {
  const pathname = (selector: Extract<CanvasRead, { endpoint: "page" }>["selector"]) =>
    buildEndpoint({ endpoint: "page", courseId: "1", selector }).url.pathname;
  assert.equal(pathname({ kind: "slug", slug: "7" }), "/api/v1/courses/1/pages/7");
  assert.equal(pathname({ kind: "id", pageId: "7" }), "/api/v1/courses/1/pages/page_id:7");
  assert.equal(pathname({ kind: "frontPage" }), "/api/v1/courses/1/front_page");
});

await test("requests reject arbitrary hosts paths credentials students and malformed filters", () => {
  for (const read of [
    { endpoint: "courses", as_user_id: "2" },
    { endpoint: "self", userId: "2" },
    { endpoint: "courses", url: "https://evil.example" },
    { endpoint: "courses", token: "secret" },
    { endpoint: "course", courseId: 1 },
    { endpoint: "course", courseId: "../users/self" },
    { endpoint: "course", courseId: "01" },
    { endpoint: "page", courseId: "1", selector: { kind: "slug", slug: "../self" } },
    { endpoint: "page", courseId: "1", selector: { kind: "slug", slug: "page_id:7" } },
    { endpoint: "calendar", startDate: "2026-11-02", endDate: "2026-11-01" },
    { endpoint: "calendar", startDate: "not-a-date", endDate: "2026-11-02" },
    { endpoint: "calendar", startDate: "2026-11-01", endDate: "2026-11-02", type: "anything" },
    { endpoint: "announcements", startDate: "2026-11-01", endDate: "2026-11-02", courseIds: [] },
    { endpoint: "missingSubmissions", courseIds: Array<string>(101).fill("1") },
    { endpoint: "unknown" },
  ])
    assert.throws(() => buildEndpoint(read as CanvasRead));
});

await test("wire responses require endpoint fields and lossless nested identifiers", () => {
  const endpoint = buildEndpoint({ endpoint: "assignments", courseId: "1" });
  const assignment = {
    id: huge,
    course_id: "1",
    name: "Work",
    submission: { assignment_id: huge, user_id: "2", workflow_state: "unsubmitted" },
  };
  assert.equal(endpoint.schema.safeParse([assignment]).success, true);
  for (const payload of [
    [],
    [{ ...assignment, id: 9007199254740992 }],
    [{ ...assignment, submission: { ...assignment.submission, user_id: 2 } }],
    [{ ...assignment, rubric: [{ criterion_id: 123 }] }],
    [{ ...assignment, associated_ids: [1] }],
    [{ id: huge }],
    { assignment },
  ]) {
    if (Array.isArray(payload) && payload.length === 0)
      assert.equal(endpoint.schema.safeParse(payload).success, true);
    else assert.equal(endpoint.schema.safeParse(payload).success, false);
  }
});

await test("all enumerated read families build validated bounded endpoints", () => {
  const reads: CanvasRead[] = [
    { endpoint: "course", courseId: "1" },
    { endpoint: "assignment", courseId: "1", assignmentId: "2" },
    { endpoint: "planner", startDate: "2026-11-01", endDate: "2026-11-02", courseIds: [huge] },
    { endpoint: "calendar", startDate: "2026-11-01", endDate: "2026-11-02" },
    { endpoint: "missingSubmissions", courseIds: [huge] },
    {
      endpoint: "announcements",
      startDate: "2026-11-01",
      endDate: "2026-11-02",
      courseIds: [huge],
    },
    { endpoint: "modules", courseId: "1" },
    { endpoint: "moduleItems", courseId: "1", moduleId: "2" },
    { endpoint: "pages", courseId: "1" },
    { endpoint: "files", courseId: "1" },
    { endpoint: "file", courseId: "1", fileId: "2" },
  ];
  for (const read of reads) {
    const result = buildEndpoint(read);
    assert.equal(result.url.origin, "https://learn.maricopa.edu");
    assert.equal(result.source, result.url.href);
    assert.equal(result.schema.safeParse("invalid").success, false);
    if (result.list) assert.equal(result.url.searchParams.get("per_page"), "100");
  }
});
