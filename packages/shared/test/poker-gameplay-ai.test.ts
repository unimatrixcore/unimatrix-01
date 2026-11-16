import { expect, it } from "vitest";
import {
  pokerGameplayAiPrepareRequestSchema,
  pokerGameplayAiResumeRequestSchema,
  pokerGameplayAiScopeSchema,
} from "../src/schemas/poker-gameplay-ai";

it("accepts optional recovery with the existing bounded job identifier", () => {
  const request = { session_id: "recording", review_after_prepare: true };
  expect(pokerGameplayAiPrepareRequestSchema.parse(request)).toEqual(request);
  for (const recover_from_job_id of ["quarantined-job", "a".repeat(256)]) {
    expect(pokerGameplayAiPrepareRequestSchema.parse({ ...request, recover_from_job_id })).toEqual({
      ...request,
      recover_from_job_id,
    });
  }
  for (const recover_from_job_id of ["", "a".repeat(257), 123, null]) {
    expect(
      pokerGameplayAiPrepareRequestSchema.safeParse({ ...request, recover_from_job_id }).success,
    ).toBe(false);
  }
});

it("retains the durable recovery source in preparation status scopes", () => {
  const scope = {
    session_id: "recording",
    frame_count: 332,
    occurrences: 0,
    unique_crops: 0,
    exact_cache_hits: 0,
    ambiguous: 0,
    profile_id: "profile",
  };
  for (const recover_from_job_id of [undefined, null, "quarantined-job"]) {
    expect(pokerGameplayAiScopeSchema.parse({ ...scope, recover_from_job_id })).toEqual({
      ...scope,
      recover_from_job_id,
    });
  }
  for (const recover_from_job_id of ["", "a".repeat(257), 123]) {
    expect(pokerGameplayAiScopeSchema.safeParse({ ...scope, recover_from_job_id }).success).toBe(
      false,
    );
  }
});

it("bounds an optional explicit Resume budget without changing job identity", () => {
  expect(pokerGameplayAiResumeRequestSchema.parse({ job_id: "existing" })).toEqual({
    job_id: "existing",
  });
  for (const max_requests of [1, 650, 10000])
    expect(pokerGameplayAiResumeRequestSchema.parse({ job_id: "existing", max_requests })).toEqual({
      job_id: "existing",
      max_requests,
    });
  for (const max_requests of [0, -1, 1.5, 10001, "650", null])
    expect(
      pokerGameplayAiResumeRequestSchema.safeParse({ job_id: "existing", max_requests }).success,
    ).toBe(false);
});
