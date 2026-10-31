import { describe, expect, it } from "vitest";

import {
  deployHealthHistoryContract,
  deployHealthHistoryQuerySchema,
  deployHealthHistoryResponseSchema,
  deployReconciliationContract,
  deployReconciliationQuerySchema,
  deployReconciliationResponseSchema,
  deployStateContract,
  deployStateQuerySchema,
  deployStateResponseSchema,
} from "../src/index.js";

const unknownContainer = {
  appDir: "api",
  kind: "unknown",
  reason: "not-polled",
  observedAt: null,
  freshness: "missing",
};
const matchedContainer = {
  appDir: "api",
  kind: "matched",
  observedAt: 123,
  containerId: "container-id",
  image: "ghcr.io/unimatrixcore/api:main",
  state: "running",
  status: "Up 1 hour",
  containerAgeMs: null,
  firstObservedAt: 100,
  lastRecreatedAt: null,
  freshness: "fresh",
};
const summary = {
  from: 0,
  to: 100,
  upMs: 0,
  downMs: 0,
  unknownMs: 100,
  uptimePercent: null,
  coveragePercent: 0,
};
const history = {
  app: "api",
  current: { app: "api", state: "unknown", checkedAt: null },
  summary,
  days: [summary],
  recent: [],
  freshness: "missing",
};
const matchedDiff = {
  verdict: "matched",
  appDir: "api",
  composeId: "compose-id",
  envFindings: [{ key: "API_TOKEN", state: "set" }],
  settingFindings: [{ setting: "branch", declared: "main", actual: "other" }],
  inSync: false,
};

function state(container: unknown) {
  return { checkedAt: 123, apps: [{ appDir: "api", publicStatus: false, container }] };
}

function reconciliation(diff: unknown) {
  return { checkedAt: 123, results: [{ appDir: "api", outcome: "diffed", diff }] };
}

describe("deployment read contracts", () => {
  it("pairs each internal GET route with its query and response schema", () => {
    for (const [contract, path, querySchema, responseSchema] of [
      [deployStateContract, "/deployment/state", deployStateQuerySchema, deployStateResponseSchema],
      [
        deployHealthHistoryContract,
        "/deployment/health",
        deployHealthHistoryQuerySchema,
        deployHealthHistoryResponseSchema,
      ],
      [
        deployReconciliationContract,
        "/deployment/reconciliation",
        deployReconciliationQuerySchema,
        deployReconciliationResponseSchema,
      ],
    ] as const) {
      expect(contract).toMatchObject({ method: "GET", path });
      expect(contract.querySchema).toBe(querySchema);
      expect(contract.responseSchema).toBe(responseSchema);
    }
  });

  it("validates app filters and rejects extra query fields", () => {
    for (const schema of [deployStateQuerySchema, deployReconciliationQuerySchema]) {
      expect(schema.parse({})).toEqual({});
      expect(schema.parse({ app: "api" })).toEqual({ app: "api" });
    }
    expect(deployHealthHistoryQuerySchema.safeParse({}).success).toBe(false);
    for (const schema of [
      deployStateQuerySchema,
      deployReconciliationQuerySchema,
      deployHealthHistoryQuerySchema,
    ]) {
      expect(schema.parse({ app: "app-1" })).toEqual({ app: "app-1" });
      for (const app of ["", "../api", "a".repeat(65), "API", ["api", "web"]]) {
        expect(schema.safeParse({ app }).success).toBe(false);
      }
      expect(schema.safeParse({ app: "api", limit: 1000 }).success).toBe(false);
    }
  });

  it("preserves missing, fresh and stale container observations", () => {
    expect(deployStateResponseSchema.parse(state(unknownContainer))).toEqual(
      state(unknownContainer),
    );
    expect(deployStateResponseSchema.parse(state(matchedContainer))).toEqual(
      state(matchedContainer),
    );
    expect(
      deployStateResponseSchema.safeParse(state({ ...matchedContainer, freshness: "stale" }))
        .success,
    ).toBe(true);
    expect(
      deployStateResponseSchema.safeParse(state({ ...unknownContainer, reason: "down" })).success,
    ).toBe(false);
    expect(
      deployStateResponseSchema.safeParse(state({ ...matchedContainer, observedAt: -1 })).success,
    ).toBe(false);
    expect(
      deployStateResponseSchema.safeParse(state({ ...matchedContainer, containerAgeMs: 1000 }))
        .success,
    ).toBe(false);
  });

  it("bounds state response size and external strings", () => {
    expect(
      deployStateResponseSchema.safeParse({
        checkedAt: 123,
        apps: Array.from({ length: 101 }, () => state(unknownContainer).apps[0]),
      }).success,
    ).toBe(false);
    for (const [key, length] of [
      ["containerId", 257],
      ["image", 2049],
      ["state", 1025],
      ["status", 1025],
    ] as const) {
      expect(
        deployStateResponseSchema.safeParse(
          state({ ...matchedContainer, [key]: "x".repeat(length) }),
        ).success,
      ).toBe(false);
    }
  });

  it("bounds history and accepts unknown health with no samples", () => {
    expect(deployHealthHistoryResponseSchema.parse(history)).toEqual(history);
    for (const freshness of ["fresh", "stale"]) {
      expect(deployHealthHistoryResponseSchema.safeParse({ ...history, freshness }).success).toBe(
        true,
      );
    }
    expect(
      deployHealthHistoryResponseSchema.safeParse({ ...history, days: Array(31).fill(summary) })
        .success,
    ).toBe(false);
    expect(
      deployHealthHistoryResponseSchema.safeParse({
        ...history,
        recent: Array(61).fill({ app: "api", checkedAt: 123, state: "up" }),
      }).success,
    ).toBe(false);
    expect(
      deployHealthHistoryResponseSchema.safeParse({
        ...history,
        summary: { ...summary, uptimePercent: 101 },
      }).success,
    ).toBe(false);
    expect(
      deployHealthHistoryResponseSchema.safeParse({
        ...history,
        current: { app: "api", state: "healthy", checkedAt: 123 },
      }).success,
    ).toBe(false);
  });

  it("accepts all reconciliation outcomes without upstream error text", () => {
    for (const diff of [
      matchedDiff,
      { verdict: "missing", appDir: "api" },
      { verdict: "ambiguous", appDir: "api", matchCount: 2 },
    ]) {
      expect(deployReconciliationResponseSchema.parse(reconciliation(diff))).toEqual(
        reconciliation(diff),
      );
    }
    expect(
      deployReconciliationResponseSchema.safeParse({
        checkedAt: 123,
        results: [{ appDir: "api", outcome: "error", reason: "read-failed" }],
      }).success,
    ).toBe(true);
    expect(
      deployReconciliationResponseSchema.safeParse({
        checkedAt: 123,
        results: [{ appDir: "api", outcome: "error", reason: "secret-bearing error" }],
      }).success,
    ).toBe(false);
  });

  it("rejects secret-bearing extra fields at nested response boundaries", () => {
    expect(
      deployStateResponseSchema.safeParse(state({ ...matchedContainer, env: "SECRET=value" }))
        .success,
    ).toBe(false);
    expect(
      deployReconciliationResponseSchema.safeParse(
        reconciliation({ ...matchedDiff, env: "SECRET=value" }),
      ).success,
    ).toBe(false);
    expect(
      deployReconciliationResponseSchema.safeParse(
        reconciliation({
          ...matchedDiff,
          envFindings: [{ key: "API_TOKEN", state: "set", value: "secret" }],
        }),
      ).success,
    ).toBe(false);
    expect(
      deployHealthHistoryResponseSchema.safeParse({
        ...history,
        recent: [{ app: "api", checkedAt: 123, state: "down", error: "secret" }],
      }).success,
    ).toBe(false);
  });

  it("bounds reconciliation results, findings and strings", () => {
    expect(
      deployReconciliationResponseSchema.safeParse({
        checkedAt: 123,
        results: Array(101).fill({ appDir: "api", outcome: "error", reason: "read-failed" }),
      }).success,
    ).toBe(false);
    for (const fields of [
      { envFindings: Array(513).fill({ key: "KEY", state: "set" }) },
      { envFindings: [{ key: "K".repeat(257), state: "set" }] },
      { settingFindings: Array(5).fill({ setting: "branch", declared: "main", actual: "other" }) },
      { settingFindings: [{ setting: "branch", declared: "main", actual: "x".repeat(4097) }] },
      { composeId: "x".repeat(257) },
    ]) {
      expect(
        deployReconciliationResponseSchema.safeParse(reconciliation({ ...matchedDiff, ...fields }))
          .success,
      ).toBe(false);
    }
  });
});
