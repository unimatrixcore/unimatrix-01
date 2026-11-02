import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { setupObservability } from "../src/plugins/observability.js";
import { ApiError, normalizeError } from "../src/lib/http/errors.js";

void test("shared correlation preserves the API completion log policy", async () => {
  const records: string[] = [];
  const app = Fastify({
    logger: { level: "info", stream: { write: (chunk: string) => records.push(chunk) } },
  });
  setupObservability(app);
  app.get("/probe", (request, reply) => {
    request.responseLogContext = { error: { code: "CLIENT_ERROR" }, custom: "diagnostic" };
    request.responseLogMessage = "API diagnostic";
    return reply.code(400).send({});
  });
  try {
    const response = await app.inject("/probe?value=kept-by-api-policy");
    const logs = records.map((record) => JSON.parse(record) as Record<string, unknown>);
    const completed = logs.find((record) => record.msg === "API diagnostic");
    assert.ok(completed);
    assert.equal(completed.level, 40);
    assert.equal(completed.url, "/probe?value=kept-by-api-policy");
    assert.equal(completed.route, "/probe");
    assert.equal(completed.requestId, response.headers["x-request-id"]);
    assert.equal(typeof completed.durationMs, "number");
    assert.equal(completed.custom, "diagnostic");
    assert.deepEqual(completed.error, { code: "CLIENT_ERROR" });
  } finally {
    await app.close();
  }
});

void test("API envelope construction still omits empty details and preserves populated issues", () => {
  for (const details of [undefined, {}, { issues: [] }]) {
    const normalized = normalizeError(
      new ApiError({
        code: "VALIDATION_ERROR",
        statusCode: 400,
        message: "Invalid",
        ...(details === undefined ? {} : { details }),
      }),
      "req-1",
    );
    assert.equal("details" in normalized.envelope.error, false);
  }
  const details = {
    issues: [{ path: "limit", code: "invalid_type", message: "Expected a number" }],
  };
  const normalized = normalizeError(
    new ApiError({ code: "VALIDATION_ERROR", statusCode: 400, message: "Invalid", details }),
    "req-2",
  );
  assert.deepEqual(normalized.envelope.error.details, details);
});
