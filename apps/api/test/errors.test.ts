import assert from "node:assert/strict";
import test from "node:test";

import { AuthError } from "@unimatrix/auth/server";

import { normalizeError } from "../src/lib/http/errors.js";

void test("normalizeError maps an unauthorized AuthError to a 401 UNAUTHORIZED envelope", () => {
  const error = new AuthError({ kind: "unauthorized" });
  const normalized = normalizeError(error, "req-1");

  assert.equal(normalized.statusCode, 401);
  assert.equal(normalized.logLevel, "warn");
  assert.deepEqual(normalized.envelope, {
    error: {
      code: "UNAUTHORIZED",
      message: "Authentication is required to access this resource.",
      statusCode: 401,
    },
    requestId: "req-1",
  });
});

void test("normalizeError maps a forbidden AuthError to a 403 FORBIDDEN envelope", () => {
  const error = new AuthError({ kind: "forbidden" });
  const normalized = normalizeError(error, "req-2");

  assert.equal(normalized.statusCode, 403);
  assert.equal(normalized.logLevel, "warn");
  assert.deepEqual(normalized.envelope, {
    error: {
      code: "FORBIDDEN",
      message: "You do not have permission to access this resource.",
      statusCode: 403,
    },
    requestId: "req-2",
  });
});

void test("normalizeError preserves a custom AuthError message", () => {
  const error = new AuthError({ kind: "forbidden", message: "Admins only." });
  const normalized = normalizeError(error, "req-3");

  assert.equal(normalized.envelope.error.message, "Admins only.");
});
