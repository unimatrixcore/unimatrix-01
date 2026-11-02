import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import {
  buildSafeLoggerOptions,
  createErrorEnvelope,
  setupRequestObservability,
} from "../src/index.js";

const privateData = "private-credential-course-grade-upstream";

function createApp() {
  const records: string[] = [];
  const app = Fastify({
    logger: buildSafeLoggerOptions({
      level: "trace",
      stream: { write: (chunk) => records.push(chunk) },
    }),
  });
  setupRequestObservability(app);
  return { app, records };
}

describe("error envelopes", () => {
  it("preserves the caller's public classification and optional details", () => {
    expect(
      createErrorEnvelope({
        requestId: "req-1",
        code: "DENIED",
        message: "Denied",
        statusCode: 403,
      }),
    ).toEqual({
      requestId: "req-1",
      error: { code: "DENIED", message: "Denied", statusCode: 403 },
    });
    expect(
      createErrorEnvelope({
        requestId: "req-2",
        code: "INVALID",
        message: "Invalid",
        statusCode: 400,
        details: { issues: [] },
      }).error.details,
    ).toEqual({ issues: [] });
  });
});

describe("safe observability", () => {
  it("retains correlation, duration and outcomes while omitting private request and response data", async () => {
    const { app, records } = createApp();
    app.post("/courses/:id", (_request, reply) => reply.send({ text: privateData }));
    app.get(
      "/invalid",
      {
        schema: {
          querystring: {
            type: "object",
            required: ["limit"],
            properties: { limit: { type: "integer" } },
          },
        },
      },
      () => ({}),
    );
    app.get("/failure", () => {
      throw Object.assign(new Error(privateData, { cause: new Error(privateData) }), {
        body: privateData,
        code: privateData,
      });
    });
    try {
      for (const [method, url, status] of [
        ["POST", `/courses/${privateData}?access_token=${privateData}`, 200],
        ["GET", `/invalid?limit=${privateData}`, 400],
        ["GET", `/failure?grade=${privateData}`, 500],
        ["GET", `/${privateData}?q=${privateData}`, 404],
      ] as const) {
        const response = await app.inject({
          method,
          url,
          headers: { authorization: privateData, cookie: privateData, "x-request-id": privateData },
          ...(method === "POST" ? { payload: { course: privateData } } : {}),
        });
        expect(response.statusCode).toBe(status);
        expect(response.headers["x-request-id"]).toBeTruthy();
        expect(response.headers["x-request-id"]).not.toBe(privateData);
      }
      const logs = records.map((record) => JSON.parse(record) as Record<string, unknown>);
      const completed = logs.filter((record) => "outcome" in record);
      expect(completed).toHaveLength(4);
      expect(completed.map((record) => record.outcome)).toEqual([
        "success",
        "client_error",
        "server_error",
        "client_error",
      ]);
      expect(completed.map((record) => record.route)).toEqual([
        "/courses/:id",
        "/invalid",
        "/failure",
        null,
      ]);
      for (const record of completed) {
        expect(record.durationMs).toEqual(expect.any(Number));
        expect(record.requestId).toEqual(expect.any(String));
        expect(record.statusCode).toEqual(expect.any(Number));
      }
      expect(records.join("")).not.toContain(privateData);
    } finally {
      await app.close();
    }
  });

  it("sanitizes direct errors, nested causes and free-text framework messages", async () => {
    const { app, records } = createApp();
    try {
      await app.ready();
      const error = Object.assign(new Error(privateData, { cause: new Error(privateData) }), {
        response: privateData,
      });
      app.log.error(error);
      app.log.error({ err: error }, privateData);
      app.log.warn(privateData);
      app.log.error(
        {
          req: { headers: { authorization: privateData }, url: privateData },
          res: { body: privateData },
        },
        privateData,
      );
      expect(records).toHaveLength(4);
      expect(records.join("")).not.toContain(privateData);
      expect(records.join("")).toContain("service event");
    } finally {
      await app.close();
    }
  });

  it("supports app-owned completion policy and a missing start time", async () => {
    const custom = Fastify();
    const durations: number[] = [];
    setupRequestObservability(custom, {
      onResponse: (_request, _reply, durationMs) => durations.push(durationMs),
    });
    custom.get("/", (request) => {
      delete request.requestStartedAt;
      return {};
    });
    try {
      await custom.inject("/");
      expect(durations).toEqual([0]);
    } finally {
      await custom.close();
    }
  });
});
