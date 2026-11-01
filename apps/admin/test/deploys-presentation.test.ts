import { ApiClientError } from "@unimatrix/api-client";
import type { DeployAttemptRecord, DeployReconciliationResponse } from "@unimatrix/shared";
import { describe, expect, it } from "vitest";

import { describeDeployError, rollbackTargets } from "@/features/deploys/deploys-page";
import {
  attemptNeedsAttention,
  outcomeLabel,
  reconciliationSummary,
} from "@/features/deploys/presentation";

function attempt(overrides: Partial<DeployAttemptRecord> = {}): DeployAttemptRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    repository: "gwenny/unimatrix-01",
    app: "api",
    trigger: "ci",
    reporterId: "ci",
    runId: "123",
    runAttempt: 1,
    requestedAt: 1000,
    deadlineAt: 2000,
    image: {
      repository: "ghcr.io/gwenny/api",
      platform: "linux/amd64",
      digestKind: "manifest",
      digest: `sha256:${"a".repeat(64)}`,
      tag: "commit-abc",
      commit: "a".repeat(40),
    },
    baseline: null,
    tagWrite: "acknowledged",
    queue: "acknowledged",
    queueClaimedAt: 1000,
    outcome: "landed",
    correlation: "verified",
    after: null,
    landedAt: 1500,
    lateLandedAt: null,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<DeployReconciliationResponse> = {},
): DeployReconciliationResponse {
  return {
    checkedAt: 2000,
    policy: "scheduled-detection-explicit-apply",
    status: "checked",
    observedAt: 1000,
    nextRunAt: 901000,
    intervalMs: 900000,
    freshness: "fresh",
    results: [],
    ...overrides,
  };
}

function matched(inSync: boolean): DeployReconciliationResponse["results"][number] {
  return {
    appDir: "api",
    outcome: "diffed",
    diff: {
      verdict: "matched",
      appDir: "api",
      composeId: "compose-api",
      inSync,
      settingFindings: [],
      envFindings: [
        { key: "PUBLIC_KEY", state: "build-arg-runtime-copy" },
        { key: "OPTIONAL", state: "optional-absent" },
        { key: "SET", state: "set" },
      ],
    },
  };
}

describe("deployment outcome presentation", () => {
  it("distinguishes unverified manual recreation from a verified deployed image", () => {
    const manual = attempt({
      trigger: "manual",
      image: null,
      runId: null,
      runAttempt: null,
      actorUserId: "operator",
      requestId: "00000000-0000-4000-8000-000000000002",
      outcome: "recreated",
      correlation: "pending",
      recreatedAt: 1500,
      tagWrite: null,
      landedAt: null,
    });

    expect(outcomeLabel(manual)).toBe("Recreated · image unverified");
    expect(outcomeLabel(attempt())).toBe("Deployed");
    expect(attemptNeedsAttention(manual)).toBe(false);
    expect(rollbackTargets([manual])).toEqual([]);
  });

  it("keeps an unapplied timeout distinct from a rejected deployment", () => {
    expect(outcomeLabel(attempt({ outcome: "timed-out", landedAt: null }))).toBe("Not applied");
    expect(outcomeLabel(attempt({ outcome: "failed", landedAt: null }))).toBe("Failed");
    expect(attemptNeedsAttention(attempt({ outcome: "timed-out", landedAt: null }))).toBe(true);
    expect(attemptNeedsAttention(attempt({ outcome: "failed", landedAt: null }))).toBe(true);
  });

  it("reports late verified landing without retaining a failure warning", () => {
    const late = attempt({ outcome: "timed-out", landedAt: null, lateLandedAt: 3000 });
    expect(outcomeLabel(late)).toBe("Deployed late");
    expect(attemptNeedsAttention(late)).toBe(false);
    expect(rollbackTargets([late])).toEqual([]);
  });

  it("offers only retained verified landed images as rollback targets", () => {
    const eligible = attempt();
    expect(
      rollbackTargets([
        eligible,
        attempt({ outcome: "queued", landedAt: null }),
        attempt({ correlation: "ambiguous" }),
        attempt({ landedAt: null }),
        attempt({ image: null }),
      ]),
    ).toEqual([eligible]);
  });
});

describe("reconciliation snapshot presentation", () => {
  it("does not equate a missing observation with no drift", () => {
    expect(
      reconciliationSummary(
        snapshot({ status: "not-checked", observedAt: null, freshness: "missing" }),
        "api",
      ),
    ).toEqual({ label: "Not checked", showDetail: false, count: 0 });
    expect(reconciliationSummary(snapshot({ results: [matched(true)] }), "web").label).toBe(
      "Not checked",
    );
  });

  it("retains a stale snapshot's findings instead of presenting them as a fresh check", () => {
    const stale = snapshot({ freshness: "stale", results: [matched(true)] });
    expect(reconciliationSummary(stale, "api")).toEqual({
      label: "No detected drift",
      showDetail: false,
      count: 0,
    });
    expect(stale.freshness).toBe("stale");
    expect(stale.observedAt).toBe(1000);
  });

  it("shows checking independently of a prior snapshot", () => {
    expect(
      reconciliationSummary(snapshot({ status: "checking", results: [matched(true)] }), "api"),
    ).toEqual({ label: "Checking", showDetail: false, count: 0 });
  });

  it("opens detail for global or per-service read failures", () => {
    for (const value of [
      snapshot({ status: "read-failed" }),
      snapshot({ results: [{ appDir: "api", outcome: "error", reason: "read-failed" }] }),
    ]) {
      expect(reconciliationSummary(value, "api")).toEqual({
        label: "Check unavailable",
        showDetail: true,
        count: 0,
      });
    }
  });

  it("does not count build argument runtime copies or optional absence as drift", () => {
    expect(reconciliationSummary(snapshot({ results: [matched(true)] }), "api")).toEqual({
      label: "No detected drift",
      showDetail: false,
      count: 0,
    });
    const result = matched(false);
    if (result.outcome !== "diffed" || result.diff.verdict !== "matched") throw new Error();
    result.diff.envFindings.push(
      { key: "MISSING", state: "missing" },
      { key: "BLANK", state: "blank" },
      { key: "EXTRA", state: "undeclared" },
    );
    result.diff.settingFindings.push({ setting: "branch", declared: "main", actual: "other" });
    expect(reconciliationSummary(snapshot({ results: [result] }), "api")).toEqual({
      label: "4 need a decision",
      showDetail: true,
      count: 4,
    });
  });

  it.each([
    ["missing", "Not created yet"],
    ["ambiguous", "Service mapping ambiguous"],
  ] as const)("does not hide %s service mappings", (verdict, label) => {
    const diff =
      verdict === "missing"
        ? { verdict, appDir: "api" }
        : { verdict, appDir: "api", matchCount: 2 };
    expect(
      reconciliationSummary(
        snapshot({ results: [{ appDir: "api", outcome: "diffed", diff }] }),
        "api",
      ),
    ).toEqual({ label, showDetail: true, count: 1 });
  });
});

describe("routing summaries", () => {
  it("keeps unavailable routing visible and counts domain and port drift", () => {
    const result = matched(true);
    if (result.outcome !== "diffed" || result.diff.verdict !== "matched") throw new Error();
    result.diff.routing = {
      sourcePath: "apps/deploy/src/reconcile/routing-policy.ts",
      status: "unavailable",
      expectedHosts: ["api.unimatrix-01.dev"],
      observedHosts: null,
      missingHosts: [],
      unexpectedHosts: [],
      declaredPort: 3001,
      observedPorts: null,
      portMismatch: false,
    };
    expect(reconciliationSummary(snapshot({ results: [result] }), "api")).toEqual({
      label: "Routing check unavailable",
      count: 0,
      showDetail: true,
    });
    result.diff.routing = {
      ...result.diff.routing,
      status: "drift",
      observedHosts: ["other.example.com"],
      missingHosts: ["api.unimatrix-01.dev"],
      unexpectedHosts: ["other.example.com"],
      observedPorts: [8080],
      portMismatch: true,
    };
    result.diff.inSync = false;
    expect(reconciliationSummary(snapshot({ results: [result] }), "api")).toEqual({
      label: "3 need a decision",
      count: 3,
      showDetail: true,
    });
  });
});

describe("deployment request errors", () => {
  it.each([
    [401, "Your session has expired. Sign in again."],
    [403, "Your account does not have deployment access."],
    [
      409,
      "Deployment request conflicts with deployment policy or pending work. Refresh before trying again.",
    ],
    [502, "The deployment service is unavailable."],
    [404, "Deployment data is unavailable. Check the API deployment configuration."],
  ])("provides an actionable message for %s", (status, message) => {
    expect(
      describeDeployError(new ApiClientError("untrusted detail", { status: Number(status) })),
    ).toBe(message);
  });

  it("does not reflect arbitrary exception text into the console", () => {
    expect(describeDeployError(new Error("sensitive upstream detail"))).toBe(
      "The request could not be completed. Refresh to check the latest state.",
    );
  });
});
