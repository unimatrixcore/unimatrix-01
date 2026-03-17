import { describe, expect, it } from "vitest";

import {
  healthContract,
  healthQuerySchema,
  healthResponseSchema,
} from "../src/index.js";

describe("health shared contract surface", () => {
  it("accepts the expected health response payload", () => {
    expect(
      healthResponseSchema.parse({
        service: "api",
        status: "ok",
      }),
    ).toEqual({
      service: "api",
      status: "ok",
    });
  });

  it("rejects invalid service and status values", () => {
    expect(
      healthResponseSchema.safeParse({
        service: "web",
        status: "ok",
      }).success,
    ).toBe(false);
    expect(
      healthResponseSchema.safeParse({
        service: "api",
        status: "degraded",
      }).success,
    ).toBe(false);
  });

  it("rejects unexpected query keys", () => {
    expect(healthQuerySchema.safeParse({ unexpected: "1" }).success).toBe(false);
  });

  it("keeps the expected method and path pairing", () => {
    expect(healthContract).toMatchObject({
      method: "GET",
      path: "/health",
    });
    expect(healthContract.responseSchema).toBe(healthResponseSchema);
  });
});
