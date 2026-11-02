import assert from "node:assert/strict";
import test from "node:test";

import {
  createCanvasConnection,
  createCanvasTransport,
  CanvasConnectionError,
} from "../src/index.js";
import { buildEndpoint, type CanvasRead } from "../src/endpoints.js";

const courses: CanvasRead = { endpoint: "courses" };
const caller = "owner";
const origin = "https://learn.maricopa.edu";
const row = (id: string) => ({ id, name: `Course ${id}` });
const nextUrl = () => {
  const url = buildEndpoint(courses).url;
  url.searchParams.set("page", "opaque-token");
  return url.href;
};
function fixture(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
  deadlineMs = 1000,
) {
  let token = "synthetic-A";
  let denial = false;
  let account = "123";
  const requests: URL[] = [];
  const connection = createCanvasConnection({
    userId: "123",
    deadlineMs,
    loadCredential: () =>
      denial
        ? Promise.reject(new CanvasConnectionError("CREDENTIAL_DENIED"))
        : Promise.resolve(token),
    fetch: async (input, init) => {
      assert.ok(init);
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.equal(new Headers(init.headers).get("accept"), "application/json+canvas-string-ids");
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      requests.push(url);
      if (url.pathname === "/api/v1/users/self") return Response.json({ id: account });
      return handler(url, init);
    },
  });
  return {
    connection,
    transport: createCanvasTransport(connection),
    requests,
    replace: (value = "synthetic-B") => {
      token = value;
    },
    account: (value: string) => {
      account = value;
    },
    deny: () => {
      denial = true;
    },
  };
}

await test("pagination returns second-page results and deduplicates repeated IDs", async () => {
  const f = fixture((url) =>
    url.searchParams.has("page")
      ? Response.json([row("1"), row("90071992547409931234")])
      : Response.json([row("1")], { headers: { link: `<${nextUrl()}>; rel="next"` } }),
  );
  const result = await f.transport.read(courses, { caller });
  assert.equal(result.sources[0]?.coverage, "complete");
  assert.deepEqual(result.sources[0]?.data, [row("1"), row("90071992547409931234")]);
  assert.equal(result.continuation, undefined);
});

await test("unsafe origin path filter impersonation and looping links never get fetched", async () => {
  const original = buildEndpoint(courses).url.href;
  for (const next of [
    nextUrl().replace(origin, "https://evil.example"),
    `${origin}/api/v1/users/self`,
    `${nextUrl()}&as_user_id=2`,
    `${nextUrl()}&access_token=private`,
    nextUrl().replace("student", "teacher"),
    original,
    "not-a-url",
  ]) {
    const f = fixture(() =>
      Response.json([row("1")], { headers: { link: `<${next}>; rel="next"` } }),
    );
    const result = await f.transport.read(courses, { caller });
    assert.equal(result.sources[0]?.coverage, "unavailable");
    assert.deepEqual(result.sources[0]?.warnings, ["CANVAS_UNSAFE_PAGINATION"]);
    assert.equal(f.requests.length, 2);
  }
});

await test("denied malformed and redirect resources cannot become empty complete success", async () => {
  for (const response of [
    new Response("private", { status: 403 }),
    new Response("private", { status: 404 }),
    Response.json([{ id: 1 }]),
    new Response("<script>private</script>"),
    new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
  ]) {
    const f = fixture(() => response);
    const result = await f.transport.read(courses, { caller });
    assert.equal(result.sources[0]?.coverage, "unavailable");
    assert.equal(result.sources[0]?.data.length, 0);
  }
  const auth = fixture(() => new Response("private", { status: 401 }));
  await assert.rejects(auth.transport.read(courses, { caller }), {
    code: "CANVAS_CREDENTIAL_REJECTED",
  });
});

await test("page-two errors preserve partial evidence and aggregate source coverage", async () => {
  const f = fixture((url) =>
    url.searchParams.has("page")
      ? Response.json({ invalid: true })
      : Response.json([row("1")], { headers: { link: `<${nextUrl()}>; rel="next"` } }),
  );
  const result = await f.transport.aggregate([courses, { endpoint: "modules", courseId: "1" }], {
    caller,
  });
  assert.equal(result.sources[0]?.coverage, "partial");
  assert.deepEqual(result.sources[0]?.data, [row("1")]);
  assert.deepEqual(result.sources[0]?.warnings, ["CANVAS_INVALID_RESPONSE"]);
  assert.equal(result.sources[1]?.coverage, "unavailable");
});

await test("one account admission serializes connection checks and transport across interfaces", async () => {
  let release!: () => void;
  const f = fixture(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return Response.json([row("1")]);
  });
  const first = f.transport.read(courses, { caller });
  while (!release) await new Promise<void>((resolve) => setImmediate(resolve));
  const status = f.connection.status();
  const second = f.transport.read(courses, { caller: "mcp" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.requests.length, 2);
  release();
  await first;
  await status;
  while (f.requests.length < 5) await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  await second;
});

await test("request and page budgets provide caller filter bound resumable source progress", async () => {
  const f = fixture((url) =>
    url.searchParams.has("page")
      ? Response.json([row("1"), row("2")])
      : url.pathname.endsWith("modules")
        ? Response.json([{ id: "3", name: "Module" }])
        : Response.json([row("1")], { headers: { link: `<${nextUrl()}>; rel="next"` } }),
  );
  const reads: CanvasRead[] = [courses, { endpoint: "modules", courseId: "1" }];
  const first = await f.transport.aggregate(reads, { caller, maxPages: 1, maxRequests: 2 });
  assert.equal(first.sources[0]?.coverage, "partial");
  assert.equal(first.sources[1]?.coverage, "not_requested");
  assert.equal(first.sources[1]?.retrievedAt, null);
  assert.ok(first.continuation);
  for (const invalid of [{ caller: "other" }, { caller, reads: [courses] }])
    await assert.rejects(
      f.transport.aggregate("reads" in invalid ? invalid.reads : reads, {
        caller: invalid.caller,
        continuation: first.continuation,
      }),
      { code: "CANVAS_INVALID_CURSOR" },
    );
  const resumed = await f.transport.aggregate(reads, { caller, continuation: first.continuation });
  assert.deepEqual(resumed.sources[0]?.data, [row("2")]);
  assert.equal(resumed.sources[1]?.coverage, "complete");
  await assert.rejects(f.transport.aggregate(reads, { caller, continuation: first.continuation }), {
    code: "CANVAS_INVALID_CURSOR",
  });
  const exhausted = await f.transport.read(courses, { caller: "budget", maxRequests: 1 });
  assert.equal(exhausted.sources[0]?.coverage, "not_requested");
  assert.ok(exhausted.continuation);
});

await test("cache hits recheck access replacement invalidates content and fresh failures expose errors", async () => {
  let failed = false;
  let content = "1";
  const f = fixture(() =>
    failed ? new Response("private", { status: 500 }) : Response.json([row(content)]),
  );
  await f.transport.read(courses, { caller });
  await f.transport.read(courses, { caller });
  assert.equal(f.requests.length, 3);
  failed = true;
  const failedFresh = await f.transport.read(courses, { caller, fresh: true });
  assert.equal(failedFresh.sources[0]?.coverage, "unavailable");
  assert.deepEqual(failedFresh.sources[0]?.data, []);
  failed = false;
  content = "2";
  f.replace();
  const replacement = await f.transport.read(courses, { caller });
  assert.deepEqual(replacement.sources[0]?.data, [row("2")]);
  f.deny();
  await assert.rejects(f.transport.read(courses, { caller }), { code: "CREDENTIAL_DENIED" });
});

await test("continuations reject changed credential generations", async () => {
  const f = fixture(() =>
    Response.json([row("1")], { headers: { link: `<${nextUrl()}>; rel="next"` } }),
  );
  const first = await f.transport.read(courses, { caller, maxPages: 1 });
  assert.ok(first.continuation);
  f.replace();
  await assert.rejects(f.transport.read(courses, { caller, continuation: first.continuation }), {
    code: "CANVAS_INVALID_CURSOR",
  });
});

await test("queue cancellation skips upstream work and backoff observes shared cancellation", async () => {
  let release!: () => void;
  const f = fixture(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return Response.json([]);
  });
  const active = f.transport.read(courses, { caller });
  while (!release) await new Promise<void>((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const queued = f.transport.read(courses, { caller, signal: controller.signal });
  controller.abort("private");
  await assert.rejects(queued, { code: "REQUEST_CANCELLED" });
  assert.equal(f.requests.length, 2);
  release();
  await active;
  const retry = fixture(
    () => new Response(null, { status: 429, headers: { "retry-after": "60" } }),
    50,
  );
  await assert.rejects(retry.transport.read(courses, { caller }), { code: "REQUEST_CANCELLED" });
  assert.equal(retry.requests.length, 2);
});

await test("cost exhaustion delays the next account call and retries consume the request budget", async () => {
  const f = fixture(
    () =>
      Response.json([], { headers: { "x-request-cost": "100", "x-rate-limit-remaining": "0" } }),
    50,
  );
  await f.transport.read(courses, { caller });
  await assert.rejects(f.connection.status(), { code: "REQUEST_CANCELLED" });
  assert.equal(f.requests.length, 2);
  const retry = fixture(() => new Response(null, { status: 429, headers: { "retry-after": "0" } }));
  const result = await retry.transport.read(courses, { caller, maxRequests: 2 });
  assert.deepEqual(result.sources[0]?.warnings, ["CANVAS_BUDGET_EXHAUSTED"]);
  assert.equal(retry.requests.length, 2);
});

await test("opaque pagination parameters are followed within unchanged selectors", async () => {
  const opaque = buildEndpoint(courses).url;
  opaque.searchParams.set("bookmark", "opaque-value");
  const f = fixture((url) =>
    url.searchParams.has("bookmark")
      ? Response.json([row("2")])
      : Response.json([row("1")], { headers: { link: `<${opaque.href}>; rel="next"` } }),
  );
  const result = await f.transport.read(courses, { caller });
  assert.equal(result.sources[0]?.coverage, "complete");
  assert.deepEqual(result.sources[0]?.data, [row("1"), row("2")]);
});

await test("cache TTL and finite cursor lifetime expire without silently serving old data", async () => {
  const actualNow = Date.now;
  let now = actualNow();
  Date.now = () => now;
  try {
    let content = "1";
    const cached = fixture(() => Response.json([row(content)]));
    await cached.transport.read(courses, { caller });
    now += 59_999;
    assert.deepEqual((await cached.transport.read(courses, { caller })).sources[0]?.data, [
      row("1"),
    ]);
    assert.equal(cached.requests.length, 3);
    now += 1;
    content = "2";
    assert.deepEqual((await cached.transport.read(courses, { caller })).sources[0]?.data, [
      row("2"),
    ]);
    assert.equal(cached.requests.length, 5);
    const paged = fixture(() =>
      Response.json([row("1")], { headers: { link: `<${nextUrl()}>; rel="next"` } }),
    );
    const first = await paged.transport.read(courses, { caller, maxPages: 1 });
    assert.ok(first.continuation);
    now += 300_001;
    await assert.rejects(
      paged.transport.read(courses, { caller, continuation: first.continuation }),
      { code: "CANVAS_INVALID_CURSOR" },
    );
  } finally {
    Date.now = actualNow;
  }
});

await test("cache and continuation capacity evict old entries", async () => {
  const f = fixture(() => Response.json([row("1")]));
  for (let index = 0; index < 65; index++)
    await f.transport.read(courses, { caller: `caller-${index}` });
  const before = f.requests.length;
  await f.transport.read(courses, { caller: "caller-0" });
  assert.equal(f.requests.length, before + 2);
  const paged = fixture(() =>
    Response.json([row("1")], { headers: { link: `<${nextUrl()}>; rel="next"` } }),
  );
  let firstCursor: string | undefined;
  for (let index = 0; index < 65; index++) {
    const result = await paged.transport.read(courses, { caller: `caller-${index}`, maxPages: 1 });
    firstCursor ??= result.continuation;
  }
  assert.ok(firstCursor);
  await assert.rejects(
    paged.transport.read(courses, { caller: "caller-0", continuation: firstCursor }),
    { code: "CANVAS_INVALID_CURSOR" },
  );
});

await test("aggregate continuation retains earlier unavailable source coverage and warnings", async () => {
  const f = fixture((url) => {
    if (url.pathname.endsWith("/modules")) return Response.json([{ id: "3", name: "Module" }]);
    return new Response(null, { status: 403 });
  });
  const reads: CanvasRead[] = [courses, { endpoint: "modules", courseId: "1" }];
  const first = await f.transport.aggregate(reads, { caller, maxRequests: 2 });
  assert.equal(first.sources[0]?.coverage, "unavailable");
  assert.ok(first.continuation);
  const resumed = await f.transport.aggregate(reads, { caller, continuation: first.continuation });
  assert.equal(resumed.sources[0]?.coverage, "unavailable");
  assert.equal(resumed.sources[0]?.retrievedAt, first.sources[0]?.retrievedAt);
  assert.deepEqual(resumed.sources[0]?.warnings, ["CANVAS_RESOURCE_UNAVAILABLE"]);
  assert.equal(resumed.sources[1]?.coverage, "complete");
});

await test("malformed pagination metadata cannot imply complete coverage", async () => {
  for (const link of [
    `<${nextUrl()}>; rel="next`,
    `<${nextUrl()}>; title="page two"`,
    `<${nextUrl()}>; rel="prev"; rel="next"`,
    `<${nextUrl()}>; rel="next", <${nextUrl()}>; rel="next"`,
  ]) {
    const f = fixture(() => Response.json([row("1")], { headers: { link } }));
    const result = await f.transport.read(courses, { caller });
    assert.equal(result.sources[0]?.coverage, "unavailable");
    assert.deepEqual(result.sources[0]?.warnings, ["CANVAS_UNSAFE_PAGINATION"]);
    assert.equal(f.requests.length, 2);
  }
});

await test("successful retry retains results and consumes the same account request budget", async () => {
  let calls = 0;
  const f = fixture(() =>
    ++calls === 1
      ? new Response(null, { status: 429, headers: { "retry-after": "0" } })
      : Response.json([row("1")]),
  );
  const result = await f.transport.read(courses, { caller, maxRequests: 3 });
  assert.equal(result.sources[0]?.coverage, "complete");
  assert.deepEqual(result.sources[0]?.data, [row("1")]);
  assert.equal(f.requests.length, 3);
});

await test("body byte bounds and stalled response cancellation fail explicitly", async () => {
  const oversized = fixture(() =>
    Response.json([row("1"), { id: "2", name: "x".repeat(1_048_576) }]),
  );
  const result = await oversized.transport.read(courses, { caller });
  assert.equal(result.sources[0]?.coverage, "unavailable");
  assert.deepEqual(result.sources[0]?.warnings, ["CANVAS_INVALID_RESPONSE"]);
  let cancelled = false;
  const stalled = fixture(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    30,
  );
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    await assert.rejects(stalled.transport.read(courses, { caller }), {
      code: "REQUEST_CANCELLED",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(keepAlive);
  }
});

await test("continuation cannot cross read and aggregate operations", async () => {
  const f = fixture(() =>
    Response.json([row("1")], { headers: { link: `<${nextUrl()}>; rel="next"` } }),
  );
  const first = await f.transport.read(courses, { caller, maxPages: 1 });
  assert.ok(first.continuation);
  await assert.rejects(
    f.transport.aggregate([courses], { caller, continuation: first.continuation }),
    { code: "CANVAS_INVALID_CURSOR" },
  );
});

await test("admission capacity bounds cancelled queue entries until the active operation releases", async () => {
  let release!: () => void;
  const f = fixture(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return Response.json([]);
  });
  const active = f.transport.read(courses, { caller });
  while (!release) await new Promise<void>((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const queued = Array.from({ length: 63 }, () => f.connection.status(controller.signal));
  const settled = Promise.allSettled(queued);
  controller.abort();
  await settled;
  await assert.rejects(f.connection.status(), { code: "CANVAS_BUDGET_EXHAUSTED" });
  assert.equal(f.requests.length, 2);
  release();
  await active;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(await f.connection.status(), { connection: "connected" });
});

await test("page and planner deduplication uses stable identities across changed payloads and continuation", async () => {
  for (const read of [
    { endpoint: "pages", courseId: "1" },
    { endpoint: "planner", startDate: "2026-11-01", endDate: "2026-11-08" },
  ] satisfies CanvasRead[]) {
    const firstRow =
      read.endpoint === "pages"
        ? { page_id: "4", url: "page", title: "original" }
        : {
            plannable_id: "4",
            plannable_type: "assignment",
            course_id: "1",
            plannable_date: "2026-11-02",
          };
    const second = buildEndpoint(read).url;
    second.searchParams.set("page", "two");
    const f = fixture((url) =>
      url.searchParams.has("page")
        ? Response.json([{ ...firstRow, title: "changed" }])
        : Response.json([firstRow], { headers: { link: `<${second.href}>; rel="next"` } }),
    );
    const first = await f.transport.read(read, { caller, maxPages: 1 });
    assert.ok(first.continuation);
    const resumed = await f.transport.read(read, { caller, continuation: first.continuation });
    assert.deepEqual(resumed.sources[0]?.data, []);
    assert.equal(resumed.sources[0]?.coverage, "complete");
  }
});

await test("an intermediate rejected credential prevents revival of original cached content and cursors", async () => {
  let paged = false;
  const f = fixture(() =>
    Response.json([row("1")], paged ? { headers: { link: `<${nextUrl()}>; rel="next"` } } : {}),
  );
  await f.transport.read(courses, { caller });
  paged = true;
  const partial = await f.transport.read(courses, { caller: "cursor", maxPages: 1 });
  assert.ok(partial.continuation);
  f.replace();
  f.account("456");
  await assert.rejects(f.transport.read(courses, { caller }), { code: "CANVAS_ACCOUNT_MISMATCH" });
  f.replace("synthetic-A");
  f.account("123");
  paged = false;
  const before = f.requests.length;
  await f.transport.read(courses, { caller });
  assert.equal(f.requests.length, before + 2);
  await assert.rejects(
    f.transport.read(courses, { caller: "cursor", continuation: partial.continuation }),
    { code: "CANVAS_INVALID_CURSOR" },
  );
});
