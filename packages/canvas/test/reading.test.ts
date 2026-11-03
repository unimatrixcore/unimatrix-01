import assert from "node:assert/strict";
import test from "node:test";

import {
  CanvasConnectionError,
  createCanvasConnection,
  createCanvasReadingWorkflows,
} from "../src/index.js";

const context = { caller: "owner" };
const enrollment = {
  course_id: "1",
  user_id: "123",
  type: "StudentEnrollment",
  enrollment_state: "active",
};
const course = { id: "1", name: "Course" };
function fixture(handler: (url: URL) => Response) {
  const requests: URL[] = [];
  let member = true;
  let token = "synthetic-token";
  const connection = createCanvasConnection({
    userId: "123",
    loadCredential: () => Promise.resolve(token),
    fetch: async (input) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      requests.push(url);
      if (url.pathname === "/api/v1/users/self")
        return await Promise.resolve(Response.json({ id: "123" }));
      if (url.pathname === "/api/v1/users/self/enrollments")
        return Response.json(member ? [enrollment] : []);
      if (url.pathname === "/api/v1/courses/1" && !url.searchParams.has("include[]"))
        return Response.json(course);
      return handler(url);
    },
  });
  return {
    reading: createCanvasReadingWorkflows(connection, { userId: "123" }),
    requests,
    revoke: () => {
      member = false;
    },
    restore: () => {
      member = true;
    },
    rotate: () => {
      token = "rotated-token";
    },
  };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof CanvasConnectionError && error.code === expected;
const pageRow = {
  page_id: "8",
  url: "7",
  title: "Reading",
  front_page: true,
  body: '<h1>Reading</h1><script>secret-script</script><a href="/courses/1">Course</a><a href="javascript:alert(1)">unsafe</a>',
};
const moduleRow = {
  id: "2",
  name: "Module",
  state: "unlocked",
  items_count: 3,
  prerequisite_module_ids: ["99"],
  require_sequential_progress: true,
};
const item = (id: string) => ({
  id,
  module_id: "2",
  title: `Item ${id}`,
  type: "Page",
  page_url: "7",
  completion_requirement: { type: "must_view", completed: false },
});

await test("syllabus requests its include and converts unsafe HTML with bounded document continuation", async () => {
  const f = fixture(() =>
    Response.json({
      ...course,
      syllabus_body: `<script>hidden</script><p>${"Reading ".repeat(2000)}</p>`,
    }),
  );
  const first = await f.reading.syllabus({ courseId: "1" }, context);
  assert.equal(first.syllabus.availability, "included");
  const doc = first.syllabus.document;
  assert.ok(doc?.truncated && doc.continuation);
  assert.ok(!doc.text.includes("hidden"));
  assert.equal(doc.text.length, 1500);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 16 * 1024);
  const second = await f.reading.syllabus(
    { courseId: "1", documentId: doc.continuation.documentId, offset: doc.continuation.offset },
    context,
  );
  assert.equal(second.syllabus.document?.offset, 1500);
  assert.ok(
    f.requests.some((url) => url.searchParams.getAll("include[]").includes("syllabus_body")),
  );
  await assert.rejects(
    f.reading.syllabus({ courseId: "1", documentId: "a".repeat(64), offset: 1 }, context),
    code("CANVAS_INVALID_CURSOR"),
  );
});

await test("pages distinguish numeric slug, explicit ID and front-page selection", async () => {
  const f = fixture((url) => Response.json(url.pathname.endsWith("/pages") ? [pageRow] : pageRow));
  assert.equal(
    (await f.reading.page({ courseId: "1", selector: "slug", pageSlug: "7" }, context)).page.id,
    "8",
  );
  assert.equal(
    (await f.reading.page({ courseId: "1", selector: "id", pageId: "8" }, context)).page.slug,
    "7",
  );
  assert.equal(
    (await f.reading.page({ courseId: "1", selector: "front_page" }, context)).page.frontPage,
    true,
  );
  assert.ok(f.requests.some((url) => url.pathname.endsWith("/pages/7")));
  assert.ok(f.requests.some((url) => url.pathname.endsWith("/pages/page_id:8")));
  assert.ok(f.requests.some((url) => url.pathname.endsWith("/front_page")));
  const list = await f.reading.pages({ courseId: "1" }, context);
  assert.equal(list.pages[0]?.availability, "not_requested");
  assert.equal(list.pages[0]?.document, null);
  const detail = await f.reading.page({ courseId: "1", selector: "slug", pageSlug: "7" }, context);
  assert.equal(
    detail.page.document?.text,
    "# Reading\n\n[Course](https://learn.maricopa.edu/courses/1)unsafe",
  );
  assert.ok(!detail.page.document?.text.includes("secret-script"));
  assert.ok(!detail.page.document?.text.includes("javascript:"));
});

await test("locked, absent and oversized documents remain distinct and never expose restricted text", async () => {
  for (const [extra, availability] of [
    [{ locked_for_user: true, body: "restricted" }, "unavailable"],
    [{ body: undefined }, "unavailable"],
    [{ body: null }, "absent"],
    [{ body: "a".repeat(262145) }, "unavailable"],
  ] as const) {
    const f = fixture(() => Response.json({ ...pageRow, ...extra }));
    const result = await f.reading.page(
      { courseId: "1", selector: "slug", pageSlug: "7" },
      context,
    );
    assert.equal(result.page.availability, availability);
    assert.equal(result.page.document, null);
    assert.ok(!JSON.stringify(result).includes("restricted"));
  }
});

await test("announcements preserve dates, course binding, conversion and targeted document continuation", async () => {
  const f = fixture(() =>
    Response.json([
      {
        id: "9",
        context_code: "course_1",
        title: "News",
        posted_at: "2026-11-01T00:00:00Z",
        message: "a".repeat(4000),
      },
    ]),
  );
  const query = { courseIds: ["1"], start: "2026-11-01", end: "2026-11-02" };
  const result = await f.reading.announcements(query, context);
  const announcement = result.announcements[0];
  assert.equal(announcement?.courseId, "1");
  assert.equal(announcement?.htmlUrl, "https://learn.maricopa.edu/courses/1/discussion_topics/9");
  assert.equal(announcement?.postedAt, "2026-11-01T00:00:00Z");
  const doc = announcement?.document;
  assert.ok(doc?.continuation);
  const next = await f.reading.announcements(
    {
      ...query,
      announcementId: "9",
      documentId: doc.continuation.documentId,
      offset: doc.continuation.offset,
    },
    context,
  );
  assert.equal(next.announcements[0]?.document?.offset, 1500);
  const request = f.requests.find((url) => url.pathname.endsWith("/announcements"));
  assert.equal(request?.searchParams.get("start_date"), query.start);
  assert.equal(request?.searchParams.get("end_date"), query.end);
  assert.deepEqual(request?.searchParams.getAll("context_codes[]"), ["course_1"]);
  await assert.rejects(
    f.reading.announcements({ ...query, courseIds: ["2"] }, context),
    code("CANVAS_COURSE_FORBIDDEN"),
  );
});

await test("modules preserve prerequisites and explicit item traversal falls back when includes are omitted or incomplete", async () => {
  for (const items of [undefined, [item("3")]]) {
    const f = fixture((url) => {
      if (url.pathname.endsWith("/modules"))
        return Response.json([{ ...moduleRow, ...(items === undefined ? {} : { items }) }]);
      if (url.pathname.endsWith("/modules/2"))
        return Response.json({ ...moduleRow, ...(items === undefined ? {} : { items }) });
      const next = new URL(url);
      next.searchParams.set("page", "next");
      return url.searchParams.has("page")
        ? Response.json([item("5")])
        : Response.json([item("3"), item("4")], {
            headers: { link: `<${next.href}>; rel="next"` },
          });
    });
    const modules = await f.reading.modules({ courseId: "1" }, context);
    assert.deepEqual(modules.modules[0]?.prerequisiteModuleIds, ["99"]);
    assert.equal(modules.modules[0]?.requireSequentialProgress, true);
    const first = await f.reading.moduleItems({ courseId: "1", moduleId: "2", limit: 1 }, context);
    assert.equal(first.items[0]?.completionRequirement?.completed, false);
    assert.equal(first.items[0]?.availability, "available");
    assert.ok(first.continuation);
    const second = await f.reading.moduleItems(
      { courseId: "1", moduleId: "2", limit: 1, cursor: first.continuation },
      context,
    );
    assert.equal(second.items[0]?.id, "4");
    assert.ok(second.continuation);
    const third = await f.reading.moduleItems(
      { courseId: "1", moduleId: "2", limit: 1, cursor: second.continuation },
      context,
    );
    assert.equal(third.items[0]?.id, "5");
    assert.equal(third.continuation, undefined);
    assert.ok(f.requests.some((url) => url.pathname.endsWith("/modules/2/items")));
    assert.ok(
      f.requests.every(
        (url) =>
          !url.pathname.endsWith("/modules") ||
          !url.searchParams.getAll("include[]").includes("items"),
      ),
    );
    assert.ok(
      f.requests.some(
        (url) =>
          url.pathname.endsWith("/modules/2") &&
          url.searchParams.getAll("include[]").includes("items"),
      ),
    );
  }
});

await test("complete embedded items avoid redundant fetches and parent locks apply to buffered continuations", async () => {
  let locked = false;
  const f = fixture(() =>
    Response.json({
      ...moduleRow,
      state: locked ? "locked" : "unlocked",
      items_count: 2,
      items: [item("3"), item("4")],
    }),
  );
  const first = await f.reading.moduleItems({ courseId: "1", moduleId: "2", limit: 1 }, context);
  assert.ok(first.continuation);
  locked = true;
  const second = await f.reading.moduleItems(
    { courseId: "1", moduleId: "2", limit: 1, cursor: first.continuation },
    context,
  );
  assert.equal(second.module.state, "locked");
  assert.equal(second.items[0]?.availability, "unavailable");
  assert.ok(!f.requests.some((url) => url.pathname.endsWith("/items")));
});

await test("unavailable collections preserve coverage instead of claiming an empty successful list", async () => {
  const f = fixture(() => new Response(null, { status: 403 }));
  const result = await f.reading.files({ courseId: "1" }, context);
  assert.deepEqual(result.files, []);
  assert.equal(result.sources.at(-1)?.coverage, "unavailable");
  assert.deepEqual(result.sources.at(-1)?.warnings, ["CANVAS_RESOURCE_UNAVAILABLE"]);
});

await test("file metadata preserves locks, size and MIME type while discarding signed downloads", async () => {
  const row = {
    id: "7",
    display_name: "Reading.pdf",
    filename: "reading.pdf",
    size: 100,
    "content-type": "application/pdf",
    locked_for_user: true,
    locked: true,
    lock_at: null,
    unlock_at: "2026-12-01T00:00:00Z",
    url: "https://files.example/download?verifier=secret",
  };
  const f = fixture((url) => Response.json(url.pathname.endsWith("/files") ? [row] : row));
  const list = await f.reading.files({ courseId: "1" }, context);
  const detail = await f.reading.file({ courseId: "1", fileId: "7" }, context);
  assert.deepEqual(detail.file, list.files[0]);
  assert.equal(detail.file.contentType, "application/pdf");
  assert.equal(detail.file.size, 100);
  assert.equal(detail.file.availability, "unavailable");
  assert.equal(detail.file.htmlUrl, "https://learn.maricopa.edu/courses/1/files/7");
  assert.ok(!JSON.stringify(detail).includes("verifier"));
  assert.ok(f.requests.every((url) => url.origin === "https://learn.maricopa.edu"));
});

await test("reading cursors bind caller, filters, credential generation and fresh membership", async () => {
  const f = fixture(() => Response.json([pageRow, { ...pageRow, page_id: "9", url: "second" }]));
  const first = await f.reading.pages({ courseId: "1", limit: 1 }, context);
  assert.ok(first.continuation);
  await assert.rejects(
    f.reading.pages({ courseId: "1", limit: 1, cursor: first.continuation }, { caller: "other" }),
    code("CANVAS_INVALID_CURSOR"),
  );
  await assert.rejects(
    f.reading.pages({ courseId: "1", limit: 2, cursor: first.continuation }, context),
    code("CANVAS_INVALID_CURSOR"),
  );
  f.revoke();
  await assert.rejects(
    f.reading.pages({ courseId: "1", limit: 1, cursor: first.continuation }, context),
    code("CANVAS_COURSE_FORBIDDEN"),
  );
  f.restore();
  f.rotate();
  await assert.rejects(
    f.reading.pages({ courseId: "1", limit: 1, cursor: first.continuation }, context),
    code("CANVAS_INVALID_CURSOR"),
  );
});

await test("large module traversal drains every item across bounded results", async () => {
  const rows = Array.from({ length: 250 }, (_, index) => item(String(index + 3)));
  const f = fixture((url) =>
    url.pathname.endsWith("/modules/2")
      ? Response.json({ ...moduleRow, items_count: rows.length })
      : Response.json(rows),
  );
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await f.reading.moduleItems({ courseId: "1", moduleId: "2", cursor }, context);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024);
    seen.push(...result.items.map((value) => value.id));
    cursor = result.continuation;
  } while (cursor);
  assert.deepEqual(
    seen,
    rows.map((value) => value.id),
  );
});

await test("oversized non-document metadata fails explicitly instead of truncating facts", async () => {
  const f = fixture(() => Response.json([{ ...pageRow, title: "title".repeat(10000) }, pageRow]));
  await assert.rejects(
    f.reading.pages({ courseId: "1" }, context),
    code("CANVAS_BUDGET_EXHAUSTED"),
  );
});

await test("targeted announcement document requests cannot report a missing resource as complete empty", async () => {
  const f = fixture(() => Response.json([]));
  await assert.rejects(
    f.reading.announcements(
      {
        courseIds: ["1"],
        start: "2026-11-01",
        end: "2026-11-02",
        announcementId: "9",
        documentId: "a".repeat(64),
        offset: 1,
      },
      context,
    ),
    code("CANVAS_RESOURCE_UNAVAILABLE"),
  );
});

await test("files hidden for the caller remain unavailable even without an explicit lock", async () => {
  const f = fixture(() =>
    Response.json({
      id: "7",
      display_name: "Hidden.pdf",
      locked: false,
      locked_for_user: false,
      hidden: true,
      hidden_for_user: true,
      lock_explanation: "Restricted material",
    }),
  );
  const result = await f.reading.file({ courseId: "1", fileId: "7" }, context);
  assert.equal(result.file.availability, "unavailable");
  assert.equal(result.file.hiddenForUser, true);
  assert.equal(result.file.lockExplanation, "Restricted material");
});
