import assert from "node:assert/strict";
import { request, type IncomingHttpHeaders } from "node:http";
import test from "node:test";
import { rootCertificates } from "node:tls";
import { createApiClient } from "@unimatrix/api-client";
import type { ServicePrincipal } from "@unimatrix/auth";
import { SecretValue, SecretsClientError } from "@unimatrix/secrets/client";
import { AuthError, type ServiceCallerVerifier } from "@unimatrix/auth/server";
import {
  canvasAgendaSchema,
  canvasAgendaContract,
  canvasAssignmentsSchema,
  canvasAssignmentResponseSchema,
  canvasSubmissionResponseSchema,
  canvasGradesResponseSchema,
  canvasAssignmentsContract,
  canvasAssignmentContract,
  canvasSubmissionContract,
  canvasGradesContract,
  canvasCoursesSchema,
  canvasConnectionStatusSchema,
  canvasCourseResponseSchema,
  canvasCoursesContract,
  canvasCourseContract,
} from "@unimatrix/shared";

import { buildApp } from "../src/app.js";
import { loadCanvasConfig } from "../src/config.js";

const config = loadCanvasConfig({
  CANVAS_USER_ID: "9007199254740993123",
  SECRETS_BASE_URL: "https://secrets:3001/",
  SECRETS_CANVAS_READ_TOKEN: "synthetic-canvas-store-reader",
  SECRETS_TLS_CERT_BASE64: Buffer.from(rootCertificates[0]!).toString("base64"),
  CANVAS_OWNER_USER_ID: "user_synthetic_owner",
  CANVAS_RESOURCE_URL: "https://canvas.example/mcp",
  CANVAS_ALLOWED_HOSTS: "canvas.example,127.0.0.1",
  CANVAS_ALLOWED_ORIGINS: "client.example",
  CLERK_SECRET_KEY: "sk_test_synthetic",
  CLERK_PUBLISHABLE_KEY: "pk_test_synthetic",
  CLERK_JWT_KEY: "synthetic-public-key",
  CLERK_ISSUER: "https://identity.example",
});

interface Response {
  status: number | undefined;
  headers: IncomingHttpHeaders;
  text: string;
}

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }) {
  const records = new Map<string, ServicePrincipal>();
  const failures = new Map<string, Error>();
  const calls: Array<{ kind: string; token: string; required: readonly string[] }> = [];
  for (const [token, credentialKind] of [
    ["api-full", "api_key"],
    ["oauth-full", "oauth_token"],
  ] as const) {
    records.set(token, {
      credentialKind,
      userId: config.ownerUserId,
      credentialId: token,
      clientId: credentialKind === "oauth_token" ? "synthetic-client" : null,
      resource: config.resource,
      capabilities: ["canvas:read", "canvas:status", "synthetic:echo"],
    });
  }
  const verify =
    (kind: ServicePrincipal["credentialKind"]) =>
    (token: string, required: readonly string[]): Promise<ServicePrincipal> => {
      calls.push({ kind, token, required });
      const failure = failures.get(token);
      if (failure) return Promise.reject(failure);
      const principal = records.get(token);
      if (
        !principal ||
        principal.credentialKind !== kind ||
        principal.resource !== config.resource
      ) {
        return Promise.reject(new AuthError({ kind: "unauthorized" }));
      }
      if (
        principal.userId !== config.ownerUserId ||
        required.some((scope) => !principal.capabilities.includes(scope))
      ) {
        return Promise.reject(new AuthError({ kind: "forbidden" }));
      }
      return Promise.resolve(principal);
    };
  const verifier: ServiceCallerVerifier = {
    verifyApiKeyCaller: verify("api_key"),
    verifyOAuthCaller: verify("oauth_token"),
  };
  const store = {
    value: "synthetic-canvas-token",
    failure: null as Error | null,
    reads: [] as string[],
  };
  const upstream = {
    id: config.canvasUserId,
    status: 200,
    calls: 0,
    empty: false,
    courseStatus: 200,
    assignmentStatus: 200,
    submissionStatus: 200,
    gradesStatus: 200,
    enrollmentStatus: 200,
    plannerStatus: 200,
    calendarStatus: 200,
    missingStatus: 200,
    paths: [] as string[],
  };
  const course = {
    id: "41",
    name: "Synthetic Astrobiology",
    course_code: "AST-101",
    time_zone: "America/Phoenix",
    workflow_state: "available",
  };
  const concludedCourse = {
    ...course,
    id: "42",
    name: "Synthetic concluded course",
    workflow_state: "completed",
  };
  const assignment = {
    id: "91",
    course_id: "41",
    name: "Synthetic field study",
    rubric: [
      {
        id: "criterion",
        points: 10,
        description: "Synthetic criterion",
        ratings: [{ arbitrary: "private-association-extra" }],
      },
    ],
    rubric_settings: {
      id: "6",
      title: "Synthetic rubric",
      points_possible: "10",
      arbitrary: "private-association-extra",
    },
    overrides: [{ id: "7", due_at: null, arbitrary: "private-association-extra" }],
    all_dates: [{ base: true, due_at: null, arbitrary: "private-association-extra" }],
    due_at: "2026-11-06T07:00:00Z",
    lock_at: null,
    unlock_at: null,
    description:
      '<p>Read <a href="/courses/41">course context</a>.</p><script>private-script</script>',
    submission_types: ["external_tool"],
    points_possible: 10,
  };
  const submission = {
    assignment_id: "91",
    user_id: config.canvasUserId,
    workflow_state: "unsubmitted",
    attempt: 0,
    submitted_at: null,
    missing: false,
    late: false,
    excused: false,
    grade_matches_current_submission: false,
    posted_at: "2026-11-01T00:00:00Z" as string | null,
    grade: "0",
    score: 0,
  };
  const app = buildApp(config, {
    verifier,
    logger: false,
    secretsClient: {
      getSecretValue: (name) => {
        store.reads.push(name);
        if (store.failure) return Promise.reject(store.failure);
        return Promise.resolve(new SecretValue(store.value));
      },
    },
    canvasFetch: (url, init) => {
      upstream.calls++;
      const address = new URL(url instanceof Request ? url.url : url.toString());
      upstream.paths.push(address.pathname);
      assert.equal(address.origin, "https://learn.maricopa.edu");
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${store.value}`);
      let body: unknown;
      let status = upstream.status;
      if (address.pathname === "/api/v1/users/self") body = { id: upstream.id };
      else if (address.pathname === "/api/v1/users/self/enrollments") {
        status = upstream.enrollmentStatus;
        body = upstream.empty
          ? []
          : [
              {
                id: "81",
                course_id: "41",
                user_id: upstream.id,
                type: "StudentEnrollment",
                enrollment_state: "active",
              },
              {
                id: "82",
                course_id: "42",
                user_id: upstream.id,
                type: "StudentEnrollment",
                enrollment_state: "completed",
              },
            ];
      } else if (address.pathname === "/api/v1/courses") {
        body = upstream.empty
          ? []
          : [
              address.searchParams.get("enrollment_state") === "completed"
                ? concludedCourse
                : course,
            ];
      } else if (/^\/api\/v1\/courses\/(41|42)$/u.test(address.pathname)) {
        status = upstream.courseStatus;
        body = address.pathname.endsWith("42") ? concludedCourse : course;
      } else if (address.pathname === "/api/v1/planner/items") {
        status = upstream.plannerStatus;
        body = [
          {
            plannable_id: "91",
            plannable_type: "assignment",
            course_id: "41",
            plannable_date: assignment.due_at,
            plannable: { id: "91", title: assignment.name },
            planner_override: { marked_complete: true, dismissed: true },
          },
        ];
      } else if (address.pathname === "/api/v1/calendar_events") {
        status = upstream.calendarStatus;
        body =
          address.searchParams.get("type") === "assignment"
            ? [
                {
                  id: "assignment_91",
                  title: assignment.name,
                  start_at: assignment.due_at,
                  end_at: assignment.due_at,
                  context_code: "course_41",
                  assignment,
                },
              ]
            : [
                {
                  id: "event_8",
                  title: "Synthetic observation day",
                  context_code: "course_41",
                  start_at: "2026-11-05T07:00:00Z",
                  end_at: "2026-11-06T07:00:00Z",
                  all_day: true,
                  all_day_date: "2026-11-05",
                },
              ];
      } else if (address.pathname === "/api/v1/users/self/missing_submissions") {
        status = upstream.missingStatus;
        body = [assignment];
      } else if (address.pathname === "/api/v1/courses/41/assignments") {
        status = upstream.assignmentStatus;
        body = [assignment, { ...assignment, id: "92" }];
      } else if (address.pathname === "/api/v1/courses/41/assignments/91") {
        status = upstream.assignmentStatus;
        body = assignment;
      } else if (address.pathname === "/api/v1/courses/41/assignments/91/submissions/self") {
        status = upstream.submissionStatus;
        body = submission;
      } else if (address.pathname === "/api/v1/courses/41/enrollments") {
        status = upstream.gradesStatus;
        body = [
          {
            id: "81",
            course_id: "41",
            user_id: config.canvasUserId,
            type: "StudentEnrollment",
            enrollment_state: "active",
            grades: {
              current_score: 0,
              current_grade: null,
              final_score: null,
              unposted_current_score: 99,
            },
          },
        ];
      } else throw new Error(`Unexpected upstream path: ${address.pathname}`);
      return Promise.resolve(new globalThis.Response(JSON.stringify(body), { status }));
    },
  });
  t.after(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;

  async function send(
    path: string,
    token?: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: body === undefined ? "GET" : "POST",
          headers: {
            host: "canvas.example",
            accept: "application/json, text/event-stream",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...extraHeaders,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            resolve({
              status: response.statusCode,
              headers: response.headers,
              text: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function mcp(
    method: string,
    params: Record<string, unknown> = {},
    token?: string,
    modern = false,
  ) {
    return send(
      "/mcp",
      token,
      {
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          ...(modern
            ? {
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                  "io.modelcontextprotocol/clientCapabilities": {},
                  "io.modelcontextprotocol/clientInfo": {
                    name: "canvas-socket-test",
                    version: "1.0.0",
                  },
                },
              }
            : {}),
        },
      },
      modern
        ? {
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": method,
            ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
          }
        : {},
    );
  }
  return {
    app,
    send,
    mcp,
    records,
    calls,
    failures,
    store,
    upstream,
    course,
    assignment,
    submission,
  };
}

function decoded(response: Response): unknown {
  const data = response.text.startsWith("event:")
    ? response.text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : response.text;
  return JSON.parse(data ?? "null") as unknown;
}

function result(response: Response): Record<string, unknown> {
  assert.equal(response.status, 200, response.text);
  const body = decoded(response) as { result: Record<string, unknown> };
  assert.ok(body.result, response.text);
  return body.result;
}

void test("HTTP and MCP share a peer budget before verification without trusting forwarded IPs", async (t) => {
  const { app, send, mcp, calls } = await fixture(t);
  assert.equal((await send("/health")).status, 200);
  for (let index = 0; index < 60; index++) {
    const response =
      index % 2 === 0
        ? await send("/api/v1/courses", "api-full")
        : await mcp("tools/list", {}, "oauth-full");
    assert.equal(response.status, 200);
  }
  assert.equal(calls.length, 60);
  for (const path of ["/api/v1/status", "/api/v1/courses"]) {
    const denied = await send(path, "api-full", undefined, {
      "x-forwarded-for": "192.0.2.99",
    });
    assert.equal(denied.status, 429);
    assert.match(denied.text, /RATE_LIMITED/);
    assert.ok(Number(denied.headers["retry-after"]) > 0);
    assert.ok(denied.headers["x-request-id"]);
    assert.equal(denied.headers["cache-control"], "no-store");
    assert.ok(!denied.text.includes("api-full"));
  }
  assert.equal((await mcp("tools/list", {}, "oauth-full")).status, 429);
  assert.equal(calls.length, 60);
  const anotherPeer = await app.inject({
    method: "GET",
    url: "/api/v1/courses",
    remoteAddress: "192.0.2.2",
    headers: { host: "canvas.example", authorization: "Bearer api-full" },
  });
  assert.equal(anotherPeer.statusCode, 200);
  assert.equal(calls.length, 61);
  assert.equal((await send("/health")).status, 200);
});

void test("failed callers spend the budget and exhaustion precedes body parsing", async (t) => {
  const { send, mcp, calls } = await fixture(t);
  for (let index = 0; index < 60; index++) {
    const response =
      index % 2 === 0
        ? await send("/api/v1/courses", "invalid")
        : await mcp("tools/list", {}, "invalid");
    assert.equal(response.status, 401);
  }
  assert.equal(calls.length, 60);
  const oversized = await send("/mcp", "oauth-full", "private-marker".repeat(6000));
  assert.equal(oversized.status, 429);
  assert.ok(!oversized.text.includes("private-marker"));
  assert.equal((await send("/api/v1/status")).status, 429);
  assert.equal(calls.length, 60);
});

void test("anonymous liveness and fixed discovery expose no detailed status", async (t) => {
  const { send, mcp, calls } = await fixture(t);
  assert.deepEqual(decoded(await send("/health")), { status: "ok" });
  const metadata = await send("/.well-known/oauth-protected-resource", undefined, undefined, {
    "x-forwarded-host": "attacker.example",
  });
  assert.equal(metadata.status, 200);
  assert.equal((decoded(metadata) as { resource: string }).resource, config.resource);
  for (const path of ["/api/v1/status", "/api/v1/courses"]) {
    const response = await send(path);
    assert.equal(response.status, 401);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.ok(response.headers["x-request-id"]);
    assert.ok(!response.text.includes("Synthetic Astrobiology"));
  }
  const protectedCatalog = await mcp("tools/list");
  assert.equal(protectedCatalog.status, 401);
  assert.match(String(protectedCatalog.headers["www-authenticate"]), /resource_metadata=/);
  assert.equal(calls.length, 0);
});

for (const modern of [false, true]) {
  void test(`HTTP and MCP return equivalent verified facts (modern protocol: ${modern})`, async (t) => {
    const { send, mcp } = await fixture(t);
    for (const [path, name, schema] of [
      ["/api/v1/status", "canvas_status", canvasConnectionStatusSchema],
      ["/api/v1/courses", "canvas_list_courses", canvasCoursesSchema],
    ] as const) {
      const http = await send(path, "api-full");
      assert.equal(http.status, 200);
      const facts = schema.parse(decoded(http));
      const response = await mcp("tools/call", { name, arguments: {} }, "oauth-full", modern);
      const toolFacts = schema.parse(result(response).structuredContent);
      if ("courses" in facts && "courses" in toolFacts) {
        assert.deepEqual(toolFacts.courses, facts.courses);
        assert.deepEqual(
          toolFacts.sources.map(({ coverage, source, sourceLinks, warnings }) => ({
            coverage,
            source,
            sourceLinks,
            warnings,
          })),
          facts.sources.map(({ coverage, source, sourceLinks, warnings }) => ({
            coverage,
            source,
            sourceLinks,
            warnings,
          })),
        );
      } else assert.deepEqual(toolFacts, facts);
      assert.equal(response.headers["mcp-session-id"], undefined);
    }
    const echo = result(
      await mcp(
        "tools/call",
        { name: "synthetic_echo", arguments: { message: "independent synthetic tool" } },
        "oauth-full",
        modern,
      ),
    );
    assert.deepEqual(echo.structuredContent, { message: "independent synthetic tool" });
    const invalid = result(
      await mcp(
        "tools/call",
        { name: "synthetic_echo", arguments: { message: "x".repeat(257) } },
        "oauth-full",
        modern,
      ),
    );
    assert.equal(invalid.isError, true);
  });
}

void test("keeps API-key and OAuth callers separate over real sockets", async (t) => {
  const { send, mcp, calls } = await fixture(t);
  assert.equal((await send("/api/v1/courses", "oauth-full")).status, 401);
  assert.equal((await mcp("tools/list", {}, "api-full")).status, 401);
  assert.deepEqual(
    calls.map(({ kind }) => kind),
    ["api_key", "oauth_token"],
  );
});

void test("malformed bearer headers fail before verification", async (t) => {
  const { send, calls } = await fixture(t);
  for (const authorization of [
    "Basic private",
    "Bearer",
    "Bearer contains spaces",
    "Bearer private\tvalue",
  ]) {
    assert.equal(
      (await send("/api/v1/courses", undefined, undefined, { authorization })).status,
      401,
    );
  }
  assert.equal(calls.length, 0);
});

void test("unexpected failures and unmatched URLs return safe correlated errors", async (t) => {
  const { send, failures } = await fixture(t);
  const privateValue = "private-upstream-token-123";
  failures.set("broken", new Error(`Provider rejected ${privateValue}`));
  const error = await send("/api/v1/courses", "broken");
  assert.equal(error.status, 500);
  assert.ok(!error.text.includes(privateValue));
  assert.ok(!error.text.includes("Provider rejected"));
  assert.match(error.text, /INTERNAL_ERROR/);
  assert.ok(error.headers["x-request-id"]);
  const missing = await send(`/not-found?credential=${privateValue}`);
  assert.equal(missing.status, 404);
  assert.ok(!missing.text.includes(privateValue));
  assert.ok(!missing.text.includes("not-found"));
  assert.match(missing.text, /NOT_FOUND/);
});

void test("oversized request bodies are rejected without reflecting content", async (t) => {
  const { send } = await fixture(t);
  const privateValue = "private-body-marker";
  const response = await send("/mcp", "oauth-full", { message: privateValue.repeat(5000) });
  assert.equal(response.status, 413);
  assert.ok(!response.text.includes(privateValue));
});

void test("unsupported media types retain a safe client-error response", async (t) => {
  const { send } = await fixture(t);
  const mediaType = "application/x-private-marker";
  const response = await send(
    "/mcp",
    "oauth-full",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { "content-type": mediaType },
  );
  assert.equal(response.status, 415);
  assert.match(response.text, /INVALID_REQUEST/);
  assert.ok(!response.text.includes(mediaType));
  assert.ok(!response.text.includes("FST_ERR_CTP_INVALID_MEDIA_TYPE"));
  assert.ok(response.headers["x-request-id"]);
});

void test("honors injected verifier denials and rechecks credentials for every request", async (t) => {
  const { send, mcp, records, calls } = await fixture(t);
  const base = records.get("api-full");
  assert.ok(base);
  records.set("wrong-owner", { ...base, userId: "user_someone_else" });
  records.set("wrong-resource", { ...base, resource: "https://other.example/mcp" });
  records.set("read-only", { ...base, capabilities: ["canvas:read"] });
  assert.equal((await send("/api/v1/courses", "wrong-owner")).status, 403);
  assert.equal((await send("/api/v1/courses", "wrong-resource")).status, 401);
  assert.equal((await send("/api/v1/status", "read-only")).status, 403);
  assert.equal((await send("/api/v1/courses", "read-only")).status, 200);
  assert.equal((await send("/api/v1/courses", "api-full")).status, 200);
  records.delete("api-full");
  assert.equal((await send("/api/v1/courses", "api-full")).status, 401);
  assert.equal((await mcp("tools/list", {}, "oauth-full")).status, 200);
  records.delete("oauth-full");
  assert.equal((await mcp("tools/list", {}, "oauth-full")).status, 401);
  assert.equal(calls.filter(({ token }) => token === "api-full").length, 2);
});

void test("capabilities filter MCP discovery and deny unavailable tools", async (t) => {
  const { mcp, records } = await fixture(t);
  const base = records.get("oauth-full");
  assert.ok(base);
  records.set("oauth-read", { ...base, capabilities: ["canvas:read"] });
  const catalog = result(await mcp("tools/list", {}, "oauth-read"));
  assert.deepEqual(
    (catalog.tools as Array<{ name: string }>).map(({ name }) => name),
    [
      "canvas_list_courses",
      "canvas_get_course",
      "canvas_list_assignments",
      "canvas_get_assignment",
      "canvas_get_submission",
      "canvas_get_grades",
      "canvas_get_agenda",
    ],
  );
  const denied = await mcp("tools/call", { name: "canvas_status", arguments: {} }, "oauth-read");
  assert.ok(!denied.text.includes('"connection":"synthetic"'));
  const body = decoded(denied) as { error?: unknown; result?: { isError?: boolean } };
  assert.ok(body.error || body.result?.isError);
});

void test("rejects untrusted MCP hosts and origins while admitting clients without Origin", async (t) => {
  const { send, mcp } = await fixture(t);
  const payload = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  assert.equal(
    (
      await send("/mcp", "oauth-full", payload, {
        host: "attacker.example",
        "x-forwarded-host": "canvas.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (await send("/mcp", "oauth-full", payload, { origin: "https://attacker.example" })).status,
    403,
  );
  assert.equal((await mcp("tools/list", {}, "oauth-full")).status, 200);
});

void test("connection status rereads the Admin credential through HTTP and MCP", async (t) => {
  const { send, mcp, store, upstream } = await fixture(t);
  assert.equal((await send("/api/v1/connection")).status, 401);
  assert.equal(store.reads.length, 0);
  assert.deepEqual(decoded(await send("/api/v1/connection", "api-full")), {
    connection: "connected",
  });
  store.value = "replacement-canvas-token";
  const response = result(
    await mcp("tools/call", { name: "canvas_connection_status", arguments: {} }, "oauth-full"),
  );
  assert.deepEqual(response.structuredContent, { connection: "connected" });
  assert.deepEqual(store.reads, [
    "integrations/canvas/access-token",
    "integrations/canvas/access-token",
  ]);
  assert.equal(upstream.calls, 2);
  upstream.id = "9007199254740993999";
  const mismatch = await send("/api/v1/connection", "api-full");
  assert.equal(mismatch.status, 409);
  assert.match(mismatch.text, /CANVAS_ACCOUNT_MISMATCH/);
  assert.ok(!mismatch.text.includes(store.value));
  assert.ok(!mismatch.text.includes(upstream.id));
});

void test("store failures and upstream rejection remain distinct from caller auth and liveness", async (t) => {
  const { send, mcp, store, upstream } = await fixture(t);
  for (const [status, code] of [
    [403, "CREDENTIAL_DENIED"],
    [404, "CREDENTIAL_MISSING"],
    [500, "CREDENTIAL_UNAVAILABLE"],
  ] as const) {
    store.failure = new SecretsClientError("private-store-error", { status });
    const http = await send("/api/v1/connection", "api-full");
    assert.equal(http.status, 503);
    assert.match(http.text, new RegExp(code));
    const tool = result(
      await mcp("tools/call", { name: "canvas_connection_status", arguments: {} }, "oauth-full"),
    );
    assert.equal(tool.isError, true);
    assert.match(JSON.stringify(tool), new RegExp(code));
    for (const serialized of [http.text, JSON.stringify(tool)]) {
      assert.ok(!serialized.includes("private-store-error"));
      assert.ok(!serialized.includes(store.value));
    }
  }
  assert.equal(upstream.calls, 0);
  store.failure = null;
  for (const status of [401, 403]) {
    upstream.status = status;
    const rejected = await send("/api/v1/connection", "api-full");
    assert.equal(rejected.status, 502);
    assert.match(rejected.text, /CANVAS_CREDENTIAL_REJECTED/);
  }
  assert.deepEqual(decoded(await send("/health")), { status: "ok" });
});

void test("course detail facts and coverage agree through HTTP and MCP", async (t) => {
  const { send, mcp } = await fixture(t);
  for (const [courseId, concluded] of [
    ["41", false],
    ["42", true],
  ] as const) {
    const http = await send(
      `/api/v1/course?courseId=${courseId}&concluded=${concluded}`,
      "api-full",
    );
    assert.equal(http.status, 200, http.text);
    const facts = canvasCourseResponseSchema.parse(decoded(http));
    const tool = canvasCourseResponseSchema.parse(
      result(
        await mcp(
          "tools/call",
          { name: "canvas_get_course", arguments: { courseId, concluded } },
          "oauth-full",
        ),
      ).structuredContent,
    );
    assert.deepEqual(tool.course, facts.course);
    assert.equal(facts.course.enrollmentState, concluded ? "completed" : "active");
    assert.equal(facts.course.effectiveTimeZone, "America/Phoenix");
    assert.deepEqual(
      tool.sources.map(({ coverage }) => coverage),
      facts.sources.map(({ coverage }) => coverage),
    );
  }
});

void test("unverified and concluded course identifiers fail closed through both interfaces", async (t) => {
  const { send, mcp, upstream } = await fixture(t);
  for (const courseId of ["999", "42"]) {
    const http = await send(`/api/v1/course?courseId=${courseId}`, "api-full");
    assert.ok(http.status && http.status >= 400, http.text);
    const code = (decoded(http) as { error: { code: string } }).error.code;
    const tool = result(
      await mcp("tools/call", { name: "canvas_get_course", arguments: { courseId } }, "oauth-full"),
    );
    assert.equal(tool.isError, true);
    assert.ok(JSON.stringify(tool).includes(code));
    assert.ok(!upstream.paths.includes(`/api/v1/courses/${courseId}`));
  }
});

void test("empty verified enrollments return an explicitly complete empty list", async (t) => {
  const { send, mcp, upstream } = await fixture(t);
  upstream.empty = true;
  const http = await send("/api/v1/courses", "api-full");
  assert.equal(http.status, 200, http.text);
  const facts = canvasCoursesSchema.parse(decoded(http));
  assert.deepEqual(facts.courses, []);
  assert.ok(facts.sources.every(({ coverage }) => coverage === "complete"));
  const tool = canvasCoursesSchema.parse(
    result(await mcp("tools/call", { name: "canvas_list_courses", arguments: {} }, "oauth-full"))
      .structuredContent,
  );
  assert.deepEqual(tool.courses, []);
  assert.deepEqual(
    tool.sources.map(({ coverage }) => coverage),
    facts.sources.map(({ coverage }) => coverage),
  );
});

void test("bounded shared queries reject invalid HTTP and MCP selectors", async (t) => {
  const { send, mcp, upstream } = await fixture(t);
  for (const [path, name, args] of [
    ["/api/v1/courses?concluded=no", "canvas_list_courses", { concluded: "no" }],
    ["/api/v1/courses?limit=101", "canvas_list_courses", { limit: 101 }],
    ["/api/v1/courses?cursor=bad", "canvas_list_courses", { cursor: "bad" }],
    ["/api/v1/courses?caller=other", "canvas_list_courses", { caller: "other" }],
    ["/api/v1/course?courseId=0", "canvas_get_course", { courseId: "0" }],
    [
      "/api/v1/course?courseId=41&userId=other",
      "canvas_get_course",
      { courseId: "41", userId: "other" },
    ],
  ] as const) {
    assert.equal((await send(path, "api-full")).status, 400);
    assert.equal(
      result(await mcp("tools/call", { name, arguments: args }, "oauth-full")).isError,
      true,
    );
  }
  assert.equal(upstream.calls, 0);
});

void test("generic API-client requests consume the shared course contracts", async (t) => {
  const { app } = await fixture(t);
  const client = createApiClient({
    baseUrl: "http://canvas.example",
    getAuthToken: () => "api-full",
    fetch: async (input, init) => {
      const response = await app.inject({
        method: "GET",
        url: new URL(input).pathname + new URL(input).search,
        headers: { ...init?.headers, host: "canvas.example" },
      });
      return {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        json: () => Promise.resolve<unknown>(response.json()),
        text: () => Promise.resolve(response.body),
      };
    },
  });
  const list = await client.request(canvasCoursesContract, {
    query: { concluded: true, limit: 1 },
  });
  assert.equal(list.courses.length, 1);
  const detail = await client.request(canvasCourseContract, { query: { courseId: "41" } });
  assert.equal(detail.course.id, "41");
});

void test("oversized course facts fail identically before the MCP host output limit", async (t) => {
  const { send, mcp, course } = await fixture(t);
  course.name = "private-course-text".repeat(2500);
  for (const [path, name, args] of [
    ["/api/v1/course?courseId=41", "canvas_get_course", { courseId: "41" }],
    ["/api/v1/courses", "canvas_list_courses", {}],
  ] as const) {
    const http = await send(path, "api-full");
    assert.equal(http.status, 503);
    assert.match(http.text, /CANVAS_BUDGET_EXHAUSTED/);
    const tool = result(await mcp("tools/call", { name, arguments: args }, "oauth-full"));
    assert.equal(tool.isError, true);
    assert.match(JSON.stringify(tool), /CANVAS_BUDGET_EXHAUSTED/);
    assert.ok(!http.text.includes("private-course-text"));
    assert.ok(!JSON.stringify(tool).includes("private-course-text"));
  }
});

void test("HTTP continuation resumes through MCP with the same verified owner and filters", async (t) => {
  const { send, mcp } = await fixture(t);
  const http = await send("/api/v1/courses?concluded=true&limit=1", "api-full");
  assert.equal(http.status, 200, http.text);
  let page = canvasCoursesSchema.parse(decoded(http));
  const ids = page.courses.map(({ id }) => id);
  assert.ok(page.continuation);
  assert.ok(page.sources.some(({ coverage }) => coverage === "partial"));
  for (let index = 0; page.continuation && index < 4; index++) {
    page = canvasCoursesSchema.parse(
      result(
        await mcp(
          "tools/call",
          {
            name: "canvas_list_courses",
            arguments: { concluded: true, limit: 1, cursor: page.continuation },
          },
          "oauth-full",
        ),
      ).structuredContent,
    );
    ids.push(...page.courses.map(({ id }) => id));
  }
  assert.equal(page.continuation, undefined);
  assert.deepEqual(ids, ["41", "42"]);
  assert.ok(page.sources.every(({ coverage }) => coverage === "complete"));
});

void test("inaccessible memberships and course resources preserve HTTP and MCP error parity", async (t) => {
  const { send, mcp, upstream } = await fixture(t);
  for (const failure of ["enrollmentStatus", "courseStatus"] as const) {
    upstream[failure] = 403;
    const http = await send("/api/v1/course?courseId=41&fresh=true", "api-full");
    assert.equal(http.status, 502, http.text);
    const code = (decoded(http) as { error: { code: string } }).error.code;
    assert.equal(code, "CANVAS_RESOURCE_UNAVAILABLE");
    const tool = result(
      await mcp(
        "tools/call",
        { name: "canvas_get_course", arguments: { courseId: "41", fresh: true } },
        "oauth-full",
      ),
    );
    assert.equal(tool.isError, true);
    assert.ok(JSON.stringify(tool).includes(code));
    upstream[failure] = 200;
  }
});

void test("assignment, own submission and visible grade facts agree through HTTP and MCP", async (t) => {
  const { send, mcp } = await fixture(t);
  for (const modern of [false, true]) {
    for (const [path, name, schema, args] of [
      ["assignments", "canvas_list_assignments", canvasAssignmentsSchema, { courseId: "41" }],
      [
        "assignment",
        "canvas_get_assignment",
        canvasAssignmentResponseSchema,
        { courseId: "41", assignmentId: "91" },
      ],
      [
        "submission",
        "canvas_get_submission",
        canvasSubmissionResponseSchema,
        { courseId: "41", assignmentId: "91" },
      ],
      [
        "grades",
        "canvas_get_grades",
        canvasGradesResponseSchema,
        { courseId: "41", gradingPeriodId: "8" },
      ],
    ] as const) {
      const http = await send(
        `/api/v1/${path}?${new URLSearchParams(args).toString()}`,
        "api-full",
      );
      assert.equal(http.status, 200, http.text);
      const facts = schema.parse(decoded(http));
      const tool = schema.parse(
        result(await mcp("tools/call", { name, arguments: args }, "oauth-full", modern))
          .structuredContent,
      );
      const withoutTimes = (value: unknown) =>
        JSON.parse(JSON.stringify(value), (key, item: unknown) =>
          ["retrievedAt", "cacheAgeMs"].includes(key) ? undefined : item,
        ) as unknown;
      assert.deepEqual(withoutTimes(tool), withoutTimes(facts));
      assert.ok(!JSON.stringify(facts).includes("private-script"));
      assert.ok(!JSON.stringify(facts).includes("unposted_current_score"));
    }
  }
});

void test("assignment cursors cross interfaces and instruction continuation remains explicit", async (t) => {
  const { send, mcp, assignment } = await fixture(t);
  const first = canvasAssignmentsSchema.parse(
    decoded(await send("/api/v1/assignments?courseId=41&limit=1", "api-full")),
  );
  assert.ok(first.continuation);
  const last = canvasAssignmentsSchema.parse(
    result(
      await mcp(
        "tools/call",
        {
          name: "canvas_list_assignments",
          arguments: { courseId: "41", limit: 1, cursor: first.continuation },
        },
        "oauth-full",
      ),
    ).structuredContent,
  );
  assert.deepEqual(
    [...first.assignments, ...last.assignments].map((row) => row.id),
    ["91", "92"],
  );
  assert.equal(last.continuation, undefined);
  assignment.description = `<p>${"synthetic instructions ".repeat(300)}</p>`;
  const detail = canvasAssignmentResponseSchema.parse(
    decoded(await send("/api/v1/assignment?courseId=41&assignmentId=91&fresh=true", "api-full")),
  );
  const continuation = detail.assignment.instructions?.continuation;
  assert.ok(continuation);
  const next = canvasAssignmentResponseSchema.parse(
    result(
      await mcp(
        "tools/call",
        {
          name: "canvas_get_assignment",
          arguments: {
            courseId: "41",
            assignmentId: "91",
            instructionDocumentId: continuation.documentId,
            instructionOffset: continuation.offset,
          },
        },
        "oauth-full",
      ),
    ).structuredContent,
  );
  assert.equal(next.assignment.instructions?.offset, continuation.offset);
});

void test("hidden scores and external-tool ambiguity survive adapters without invented completion", async (t) => {
  const { send, mcp, submission } = await fixture(t);
  submission.posted_at = null;
  for (const facts of [
    canvasSubmissionResponseSchema.parse(
      decoded(await send("/api/v1/submission?courseId=41&assignmentId=91", "api-full")),
    ),
    canvasSubmissionResponseSchema.parse(
      result(
        await mcp(
          "tools/call",
          { name: "canvas_get_submission", arguments: { courseId: "41", assignmentId: "91" } },
          "oauth-full",
        ),
      ).structuredContent,
    ),
  ]) {
    assert.equal(facts.submission.gradeVisibility, "hidden");
    assert.equal(facts.submission.workflowState, "unsubmitted");
    assert.equal(facts.submission.missing, false);
    assert.ok(!("score" in facts.submission));
    assert.ok(!("grade" in facts.submission));
  }
});

void test("coursework failures, enrollment denial and invalid selectors have interface parity", async (t) => {
  const { send, mcp, upstream } = await fixture(t);
  for (const [path, name, failure] of [
    ["assignments", "canvas_list_assignments", "assignmentStatus"],
    ["assignment", "canvas_get_assignment", "assignmentStatus"],
    ["submission", "canvas_get_submission", "submissionStatus"],
    ["grades", "canvas_get_grades", "gradesStatus"],
  ] as const) {
    const args =
      path === "assignment" || path === "submission"
        ? { courseId: "41", assignmentId: "91" }
        : { courseId: "41" };
    upstream[failure] = 403;
    const http = await send(
      `/api/v1/${path}?${new URLSearchParams(args).toString()}&fresh=true`,
      "api-full",
    );
    assert.equal(http.status, 502, http.text);
    const tool = result(
      await mcp("tools/call", { name, arguments: { ...args, fresh: true } }, "oauth-full"),
    );
    assert.equal(tool.isError, true);
    assert.match(JSON.stringify(tool), /CANVAS_RESOURCE_UNAVAILABLE/);
    upstream[failure] = 200;
    assert.equal((await send(`/api/v1/${path}`, "api-full")).status, 400);
    assert.equal((await send(`/api/v1/${path}`)).status, 401);
    assert.equal(
      (
        await send(
          `/api/v1/${path}?${new URLSearchParams({ ...args, courseId: "999" }).toString()}`,
          "api-full",
        )
      ).status,
      403,
    );
  }
  for (const [path, args] of [
    ["assignments", { courseId: "41", userId: "other" }],
    ["assignment", { courseId: "41", assignmentId: "91", instructionOffset: "10" }],
    ["grades", { courseId: "41", gradingPeriodId: "0" }],
  ] as const)
    assert.equal(
      (await send(`/api/v1/${path}?${new URLSearchParams(args).toString()}`, "api-full")).status,
      400,
    );
});

void test("generic API client consumes coursework contracts", async (t) => {
  const { app } = await fixture(t);
  const client = createApiClient({
    baseUrl: "http://canvas.example",
    getAuthToken: () => "api-full",
    fetch: async (input, init) => {
      const response = await app.inject({
        method: "GET",
        url: new URL(input).pathname + new URL(input).search,
        headers: { ...init?.headers, host: "canvas.example" },
      });
      return {
        ok: response.statusCode === 200,
        status: response.statusCode,
        json: () => Promise.resolve<unknown>(response.json()),
        text: () => Promise.resolve(response.body),
      };
    },
  });
  assert.equal(
    (await client.request(canvasAssignmentsContract, { query: { courseId: "41" } })).assignments
      .length,
    2,
  );
  assert.equal(
    (
      await client.request(canvasAssignmentContract, {
        query: { courseId: "41", assignmentId: "91" },
      })
    ).assignment.id,
    "91",
  );
  assert.equal(
    (
      await client.request(canvasSubmissionContract, {
        query: { courseId: "41", assignmentId: "91" },
      })
    ).submission.score,
    0,
  );
  const grades = await client.request(canvasGradesContract, {
    query: { courseId: "41", gradingPeriodId: "8" },
  });
  assert.equal(grades.grades[0]?.grades?.currentScore, 0);
  assert.equal(grades.grades[0]?.grades?.currentGrade, null);
  assert.ok(!("finalGrade" in grades.grades[0].grades));
  assert.equal(grades.grades[0]?.gradingPeriodId, "8");
});

for (const failure of ["association", "instructions"] as const) {
  void test(`oversized ${failure} does not block assignment lists through either interface`, async (t) => {
    const { send, mcp, assignment } = await fixture(t);
    if (failure === "association") {
      const criterion = assignment.rubric[0];
      assert.ok(criterion);
      criterion.description = "x".repeat(24_000);
    } else assignment.description = "x".repeat(270_000);
    const http = await send("/api/v1/assignments?courseId=41&limit=1", "api-full");
    assert.equal(http.status, 200, http.text);
    const first = canvasAssignmentsSchema.parse(decoded(http));
    assert.equal(first.assignments[0]?.id, "91");
    assert.ok(
      first.assignments[0]?.omittedFields.includes(
        failure === "association" ? "rubric" : "instructions",
      ),
    );
    assert.ok(first.assignments[0]?.warnings.length);
    assert.equal(first.assignments[0]?.dueAt, assignment.due_at);
    assert.ok(first.continuation);
    assert.ok(!http.text.includes("private-association-extra"));
    assert.ok(Buffer.byteLength(http.text) <= 16 * 1024);
    const next = canvasAssignmentsSchema.parse(
      result(
        await mcp(
          "tools/call",
          {
            name: "canvas_list_assignments",
            arguments: { courseId: "41", limit: 1, cursor: first.continuation },
          },
          "oauth-full",
        ),
      ).structuredContent,
    );
    assert.equal(next.assignments[0]?.id, "92");
    assert.equal(next.continuation, undefined);
    assert.equal(next.sources.at(-1)?.coverage, "complete");
    const tool = canvasAssignmentsSchema.parse(
      result(
        await mcp(
          "tools/call",
          {
            name: "canvas_list_assignments",
            arguments: { courseId: "41", limit: 1 },
          },
          "oauth-full",
        ),
      ).structuredContent,
    );
    assert.deepEqual(tool.assignments, first.assignments);
  });
}

const agendaWindow = { start: "2026-11-01", end: "2026-11-08" };

void test("agenda facts and source coverage agree over HTTP and both MCP protocols", async (t) => {
  const { send, mcp } = await fixture(t);
  const http = await send(
    `/api/v1/agenda?${new URLSearchParams({ ...agendaWindow, courseIds: JSON.stringify(["41"]) }).toString()}`,
    "api-full",
  );
  assert.equal(http.status, 200, http.text);
  const facts = canvasAgendaSchema.parse(decoded(http));
  assert.equal(facts.effectiveTimeZone, config.timeZone);
  assert.equal(facts.items.filter(({ kind }) => kind === "assignment").length, 1);
  assert.ok(facts.items.some(({ kind }) => kind === "event"));
  const assignment = facts.items.find(({ kind }) => kind === "assignment");
  assert.ok(assignment);
  assert.equal(assignment.assignmentId, "91");
  assert.equal(assignment.submission?.workflowState, "unsubmitted");
  assert.ok(assignment.evidence.some(({ completed }) => completed === true));
  for (const modern of [false, true]) {
    const tool = canvasAgendaSchema.parse(
      result(
        await mcp(
          "tools/call",
          {
            name: "canvas_get_agenda",
            arguments: { ...agendaWindow, courseIds: ["41"] },
          },
          "oauth-full",
          modern,
        ),
      ).structuredContent,
    );
    const stable = (value: unknown) =>
      JSON.parse(JSON.stringify(value), (key, item: unknown) =>
        ["retrievedAt", "cacheAgeMs"].includes(key) ? undefined : item,
      ) as unknown;
    assert.deepEqual(stable(tool), stable(facts));
  }
});

void test("agenda HTTP continuation resumes over MCP without repeating assignments", async (t) => {
  const { send, mcp } = await fixture(t);
  let page = canvasAgendaSchema.parse(
    decoded(
      await send(
        `/api/v1/agenda?${new URLSearchParams({ ...agendaWindow, limit: "1" }).toString()}`,
        "api-full",
      ),
    ),
  );
  const keys = page.items.map(({ key }) => key);
  assert.ok(page.continuation);
  for (let index = 0; page.continuation && index < 12; index++) {
    page = canvasAgendaSchema.parse(
      result(
        await mcp(
          "tools/call",
          {
            name: "canvas_get_agenda",
            arguments: { ...agendaWindow, limit: 1, cursor: page.continuation },
          },
          "oauth-full",
        ),
      ).structuredContent,
    );
    keys.push(...page.items.map(({ key }) => key));
  }
  assert.equal(page.continuation, undefined);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.length, 2);
  assert.equal(page.coverage, "complete");
});

void test("agenda selectors and credentials are checked before upstream access", async (t) => {
  const { send, mcp, upstream } = await fixture(t);
  assert.equal((await send("/api/v1/agenda")).status, 401);
  assert.equal((await send("/api/v1/agenda", "oauth-full")).status, 401);
  for (const args of [
    {},
    { ...agendaWindow, timeZone: "Invalid/Zone" },
    { ...agendaWindow, end: "2026-10-01" },
    { ...agendaWindow, cursor: "bad" },
    { ...agendaWindow, caller: "other" },
  ]) {
    assert.equal(
      (await send(`/api/v1/agenda?${new URLSearchParams(args).toString()}`, "api-full")).status,
      400,
    );
    assert.equal(
      result(
        await mcp(
          "tools/call",
          {
            name: "canvas_get_agenda",
            arguments: args,
          },
          "oauth-full",
        ),
      ).isError,
      true,
    );
  }
  assert.equal(upstream.calls, 0);
});

void test("agenda source failures retain partial coverage through HTTP and MCP", async (t) => {
  const { send, mcp, upstream } = await fixture(t);
  upstream.plannerStatus = 403;
  const http = await send(
    `/api/v1/agenda?${new URLSearchParams({ ...agendaWindow, courseIds: JSON.stringify(["41"]) }).toString()}`,
    "api-full",
  );
  assert.equal(http.status, 200, http.text);
  const facts = canvasAgendaSchema.parse(decoded(http));
  assert.equal(facts.coverage, "partial");
  assert.notEqual(facts.nothingDue, true);
  assert.ok(facts.sources.some(({ coverage }) => coverage === "unavailable"));
  const tool = canvasAgendaSchema.parse(
    result(
      await mcp(
        "tools/call",
        {
          name: "canvas_get_agenda",
          arguments: { ...agendaWindow, courseIds: ["41"] },
        },
        "oauth-full",
      ),
    ).structuredContent,
  );
  assert.equal(tool.coverage, facts.coverage);
  assert.deepEqual(tool.items, facts.items);
});

void test("agenda validates resolved windows with coded request errors over HTTP and MCP", async (t) => {
  const { send, mcp, upstream } = await fixture(t);
  for (const args of [
    { start: "2026-11-03", end: "2026-11-03T01:00:00Z", timeZone: "America/Phoenix" },
    { start: "2026-10-01", end: "2027-01-02", timeZone: "America/New_York" },
    { start: "2026-01-01", end: "2027-01-01", timeZone: "America/Phoenix" },
  ]) {
    const http = await send(`/api/v1/agenda?${new URLSearchParams(args).toString()}`, "api-full");
    assert.equal(http.status, 400, http.text);
    assert.match(http.text, /CANVAS_INVALID_REQUEST/);
    for (const modern of [false, true]) {
      const error = result(
        await mcp(
          "tools/call",
          { name: "canvas_get_agenda", arguments: args },
          "oauth-full",
          modern,
        ),
      );
      assert.equal(error.isError, true);
      assert.match(JSON.stringify(error.content), /CANVAS_INVALID_REQUEST/);
    }
  }
  assert.equal(upstream.calls, 0);
  const valid = {
    start: "2026-11-03T01:00:00Z",
    end: "2026-11-03",
    timeZone: "America/Phoenix",
    courseIds: JSON.stringify(["41"]),
  };
  const http = await send(`/api/v1/agenda?${new URLSearchParams(valid).toString()}`, "api-full");
  assert.equal(http.status, 200, http.text);
});

void test("generic API client consumes the agenda contract", async (t) => {
  const { app } = await fixture(t);
  const client = createApiClient({
    baseUrl: "http://canvas.example",
    getAuthToken: () => "api-full",
    fetch: async (input, init) => {
      const response = await app.inject({
        method: "GET",
        url: new URL(input).pathname + new URL(input).search,
        headers: { ...init?.headers, host: "canvas.example" },
      });
      return {
        ok: response.statusCode === 200,
        status: response.statusCode,
        json: () => Promise.resolve<unknown>(response.json()),
        text: () => Promise.resolve(response.body),
      };
    },
  });
  const facts = await client.request(canvasAgendaContract, {
    query: { ...agendaWindow, courseIds: ["41"] },
  });
  assert.ok(facts.items.length);
  assert.equal(facts.effectiveTimeZone, config.timeZone);
});
