import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GameplayAiReview } from "../src/collector/gameplay-ai-review";
import { LabQueryProvider, labQueryClient } from "../src/lib/background-lists";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  labQueryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(
  state: string,
  preparation?: Promise<unknown>,
  suit = false,
  delayResponse = false,
  budget?: { limit: number; requests: number },
  recoverySource?: string,
  recoveryCandidate?: string,
) {
  let jobId = state === "quarantined" ? "quarantined-run" : "durable-run";
  const scope = {
    session_id: "scope",
    frame_count: 332,
    occurrences: 5,
    unique_crops: 5,
    exact_cache_hits: 0,
    ambiguous: 0,
    profile_id: "profile",
    ...(recoverySource ? { recover_from_job_id: recoverySource } : {}),
  };
  const job = () => ({
    id: jobId,
    ...(recoveryCandidate ? { recovery_candidate_job_id: recoveryCandidate } : {}),
    state,
    preparation: { processed_frames: 25, total_frames: 332 },
    auto_correct: false,
    ...(budget
      ? {
          max_requests: budget.limit,
          error: "Gameplay request budget reached; no further API request was sent",
        }
      : {}),
    revision: 0,
    scope,
    counts: {
      total: 5,
      pending: 5,
      verified: 0,
      corrected: 0,
      manual: 0,
      needs_review: 0,
      ambiguous: 0,
      error: 0,
      frames_completed: 0,
      frames_total: 332,
    },
    usage: {
      exact_cache_hits: 0,
      near_cache_hits: 0,
      requests: budget?.requests ?? 0,
      input_tokens: 0,
      output_tokens: 0,
    },
  });
  const request = vi.fn((url: string, options?: RequestInit) => {
    if (options?.signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    let value: unknown;
    if (url.includes("/items?"))
      value = {
        items: suit
          ? [
              {
                id: "club",
                frame_id: "frame",
                region_id: "community_cards[1].suit",
                category: "suit",
                label: "",
                original_label: "",
                state: "conflict",
                reason: "Conflicting readings",
                crop_url: "/club.png",
                image_url: "/frame.png",
                cache_kind: "miss",
                revision: 0,
              },
            ]
          : [],
        nextCursor: null,
        hasMore: false,
        total: suit ? 1 : 0,
        meta: {},
      };
    else if (url.endsWith("/prepare")) {
      const intent = JSON.parse(typeof options?.body === "string" ? options.body : "{}") as {
        review_after_prepare: boolean;
        auto_correct: boolean;
      };
      if (!intent.review_after_prepare) throw new Error("Missing automatic review intent");
      const response = () => ({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ scope, run_id: "extraction-run", job_id: jobId }),
      });
      if (state === "quarantined") {
        jobId = "current-policy-job";
        state = "prepared";
        return Promise.resolve(response());
      }
      if (state === "prepared" || state === "failed") {
        state = "running";
        return Promise.resolve(response());
      }
      if (!preparation) throw new Error("Unexpected re-preparation");
      state = "preparing";
      void preparation.then(() => {
        if (state === "preparing") state = "running";
      });
      return delayResponse ? preparation.then(response) : Promise.resolve(response());
    } else {
      if (url.endsWith("/stop")) state = "paused";
      if (url.endsWith("/start") || url.endsWith("/resume")) state = "queued";
      value = { job: state === "absent" ? null : job() };
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(value) });
  });
  vi.stubGlobal("fetch", request);
  render(
    <LabQueryProvider>
      <GameplayAiReview sessionId="scope" frameCount={332} active />
    </LabQueryProvider>,
  );
  return request;
}

it("reads durable preparation progress without re-preparing or claiming verified frames", async () => {
  const request = fixture("preparing");
  await screen.findByText("25 / 332 frames");
  expect(screen.getByRole("progressbar", { name: "Preparation progress" })).toHaveAttribute(
    "value",
    "25",
  );
  expect(screen.queryByText(/frames verified/)).not.toBeInTheDocument();
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  expect(request.mock.calls.some(([url]) => url.includes("/items?"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Pause preparation" }));
  await screen.findByRole("button", { name: "Resume preparation" });
  expect(request.mock.calls.find(([url]) => url.endsWith("/stop"))?.[1]?.body).toBe(
    JSON.stringify({ job_id: "durable-run" }),
  );
});

it("starts an initially unverified scope once and accepts its separate durable job ID", async () => {
  const request = fixture("absent", Promise.resolve());
  await screen.findByText("Unverified");
  fireEvent.click(screen.getByRole("button", { name: "Auto-correction enabled" }));
  fireEvent.click(screen.getByRole("button", { name: "Start review" }));
  await screen.findByRole("button", { name: "Pause review" });
  expect(request.mock.calls.filter(([url]) => url.endsWith("/prepare"))).toHaveLength(1);
  expect(request.mock.calls.find(([url]) => url.endsWith("/prepare"))?.[1]?.body).toBe(
    JSON.stringify({
      session_id: "scope",
      review_after_prepare: true,
      auto_correct: false,
      max_requests: 100,
    }),
  );
  const prepareIndex = request.mock.calls.findIndex(([url]) => url.endsWith("/prepare"));
  expect(request.mock.calls.slice(prepareIndex + 1).some(([url]) => url.includes("/status?"))).toBe(
    true,
  );
  expect(request.mock.calls.some(([url]) => url.endsWith("/start"))).toBe(false);
  expect(screen.queryByRole("region", { name: "Review queue" })).not.toBeInTheDocument();
});

it.each(["paused", "quarantined"])(
  "rejects a fresh unrelated or old status after %s preparation",
  async (state) => {
    const request = fixture(state, Promise.resolve());
    const action = state === "quarantined" ? "Recheck review" : "Resume preparation";
    await screen.findByRole("button", { name: action });
    const original = request.getMockImplementation()!;
    request.mockImplementation((url, options) =>
      original(url, options).then(async (response) => {
        if (!url.includes("/status?")) return response;
        const value = (await response.json()) as { job: { id: string } };
        value.job.id = state === "quarantined" ? "quarantined-run" : "another-recording-run";
        return { ...response, json: () => Promise.resolve(value) };
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Prepared scope changed");
    expect(request.mock.calls.filter(([url]) => url.endsWith("/prepare"))).toHaveLength(1);
    expect(request.mock.calls.some(([url]) => url.endsWith("/start"))).toBe(false);
    expect(screen.queryByRole("textbox", { name: "Correct reading" })).not.toBeInTheDocument();
  },
);

it("rechecks quarantine only explicitly with current settings and accepts a new job through completion", async () => {
  const request = fixture("quarantined", undefined, true);
  await screen.findByText("Quarantined", { exact: true });
  expect(screen.getByRole("button", { name: "Recheck review" })).toBeEnabled();
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  expect(screen.queryByRole("region", { name: "Review queue" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("spinbutton", { name: "Request limit" }), {
    target: { value: "240" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Auto-correction disabled" }));
  let nextState = "prepared";
  const original = request.getMockImplementation()!;
  request.mockImplementation((url, options) =>
    original(url, options).then(async (response) => {
      if (!url.includes("/status?")) return response;
      const value = (await response.json()) as { job: { id: string; state: string } };
      if (value.job.id === "current-policy-job") value.job.state = nextState;
      return { ...response, json: () => Promise.resolve(value) };
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Recheck review" }));
  await screen.findByText("prepared", { exact: true });
  expect(screen.queryByRole("region", { name: "Review queue" })).not.toBeInTheDocument();
  nextState = "running";
  await screen.findByText("ChatGPT review", {}, { timeout: 4000 });
  expect(screen.queryByRole("region", { name: "Review queue" })).not.toBeInTheDocument();
  nextState = "completed";
  await screen.findByRole("region", { name: "Review queue" }, { timeout: 4000 });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    request.mock.calls
      .filter(([, options]) => options?.method === "POST")
      .map(([url, options]) => ({
        url,
        body: JSON.parse(typeof options?.body === "string" ? options.body : "{}") as unknown,
      })),
  ).toEqual([
    {
      url: "/api/gameplay/ai/prepare",
      body: {
        session_id: "scope",
        review_after_prepare: true,
        auto_correct: true,
        max_requests: 240,
        recover_from_job_id: "quarantined-run",
      },
    },
  ]);
});

it("keeps quarantine settings drafts across remount without posting recovery", async () => {
  fixture("quarantined");
  await screen.findByRole("button", { name: "Recheck review" });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Request limit" }), {
    target: { value: "360" },
  });
  const correction = screen.queryByRole("button", { name: "Auto-correction enabled" });
  if (correction) fireEvent.click(correction);
  cleanup();
  const request = fixture("quarantined");
  await screen.findByRole("button", { name: "Recheck review" });
  expect(screen.getByRole("spinbutton", { name: "Request limit" })).toHaveValue(360);
  expect(screen.getByRole("button", { name: "Auto-correction disabled" })).toBeEnabled();
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

for (const state of ["preparing", "prepared", "running", "paused"]) {
  it(`hides the manual queue, filter counters and inspector for ${state}`, async () => {
    const request = fixture(state, undefined, true);
    await screen.findByText(
      state === "preparing" ? "Extracting crops" : state === "running" ? "ChatGPT review" : state,
      { exact: true },
    );
    expect(screen.queryByRole("region", { name: "Review queue" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Review filters" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Correct reading" })).not.toBeInTheDocument();
    expect(request.mock.calls.some(([url]) => url.includes("/items?"))).toBe(false);
  });
}

it("hides review evidence while preparation continues", async () => {
  const request = fixture("preparing", undefined, true);
  await screen.findByText("25 / 332 frames");
  expect(screen.queryByRole("group", { name: "Card suit" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Review queue" })).not.toBeInTheDocument();
  expect(request.mock.calls.some(([url]) => url.includes("/items?"))).toBe(false);
});

it("uses actual suit glyphs to fill the accepted letter without posting until save", async () => {
  const request = fixture("completed", undefined, true);
  await screen.findByRole("group", { name: "Card suit" });
  for (const [name, glyph, letter] of [
    ["Diamonds", "♦", "d"],
    ["Hearts", "♥", "h"],
    ["Clubs", "♣", "c"],
    ["Spades", "♠", "s"],
  ]) {
    const button = screen.getByRole("button", { name: `${name} (${letter})` });
    expect(button).toHaveTextContent(glyph!);
    fireEvent.click(button);
    expect(screen.getByRole("textbox", { name: "Correct reading" })).toHaveValue(letter);
    expect(button).toHaveAttribute("aria-pressed", "true");
  }
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

it("does not start paid review when preparation resolves after a pause", async () => {
  let finishPreparation = () => {};
  const preparation = new Promise<void>((resolve) => {
    finishPreparation = resolve;
  });
  const request = fixture("absent", preparation, false, true);
  await screen.findByText("Unverified");
  fireEvent.click(screen.getByRole("button", { name: "Start review" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Pause preparation" }, { timeout: 4000 }),
  );
  await screen.findByRole("button", { name: "Resume preparation" });
  await act(async () => {
    finishPreparation();
    await preparation;
  });
  expect(request.mock.calls.some(([url]) => url.endsWith("/start"))).toBe(false);
  expect(screen.getByRole("button", { name: "Resume preparation" })).toBeEnabled();
});

it("keeps pause pending until durable acknowledgement and rejects duplicate clicks", async () => {
  const request = fixture("preparing", undefined, true);
  await screen.findByRole("button", { name: "Pause preparation" });
  const original = request.getMockImplementation()!;
  const initialResult: unknown = request.mock.results.find((_, index) =>
    request.mock.calls[index]?.[0].includes("/status?"),
  )!.value;
  const initial = await (initialResult as Promise<{ json: () => Promise<unknown> }>);
  const snapshot = (await initial.json()) as { job: Record<string, unknown> };
  let state = "preparing";
  let finishStop = () => {};
  const stop = new Promise<void>((resolve) => {
    finishStop = resolve;
  });
  const response = (nextState: string) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ job: { ...snapshot.job, state: nextState } }),
  });
  request.mockImplementation((url, options) => {
    if (url.endsWith("/stop")) return stop.then(() => response("preparing"));
    if (url.includes("/status?")) return Promise.resolve(response(state));
    return original(url, options);
  });
  fireEvent.click(screen.getByRole("button", { name: "Pause preparation" }));
  const pending = await screen.findByRole("button", { name: "Pausing preparation" });
  expect(pending).toBeDisabled();
  fireEvent.click(pending);
  expect(request.mock.calls.filter(([url]) => url.endsWith("/stop"))).toHaveLength(1);
  await act(async () => {
    finishStop();
    await stop;
  });
  expect(screen.getByRole("button", { name: "Pausing preparation" })).toBeDisabled();
  state = "paused";
  await screen.findByRole("button", { name: "Resume preparation" }, { timeout: 4000 });
  expect(screen.queryByRole("textbox", { name: "Correct reading" })).not.toBeInTheDocument();
  expect(request.mock.calls.some(([url]) => url.endsWith("/start"))).toBe(false);
});

it("ignores a preparing status begun before pause and continues polling after it", async () => {
  const request = fixture("preparing", undefined, true);
  await screen.findByRole("button", { name: "Pause preparation" });
  const original = request.getMockImplementation()!;
  const initialResult: unknown = request.mock.results.find((_, index) =>
    request.mock.calls[index]?.[0].includes("/status?"),
  )!.value;
  const initial = await (initialResult as Promise<{ json: () => Promise<unknown> }>);
  const snapshot = (await initial.json()) as { job: Record<string, unknown> };
  let staleRead = false;
  let finishRead = () => {};
  const stale = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  const response = (state: string) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ job: { ...snapshot.job, state } }),
  });
  request.mockImplementation((url, options) => {
    if (url.endsWith("/stop")) return Promise.resolve(response("paused"));
    if (url.includes("/status?")) {
      if (!staleRead) {
        staleRead = true;
        return stale.then(() => response("preparing"));
      }
      return Promise.resolve(response("paused"));
    }
    return original(url, options);
  });
  await waitFor(
    () => {
      expect(staleRead).toBe(true);
    },
    { timeout: 4000 },
  );
  fireEvent.click(screen.getByRole("button", { name: "Pause preparation" }));
  await screen.findByRole("button", { name: "Resume preparation" });
  const reads = request.mock.calls.filter(([url]) => url.includes("/status?")).length;
  await act(async () => {
    finishRead();
    await stale;
  });
  expect(screen.getByRole("button", { name: "Resume preparation" })).toBeEnabled();
  await waitFor(
    () => {
      expect(request.mock.calls.filter(([url]) => url.includes("/status?")).length).toBeGreaterThan(
        reads,
      );
    },
    { timeout: 4000 },
  );
});

it("resumes preparation with a durable review intent and never posts a client start", async () => {
  let finishPreparation = () => {};
  const preparation = new Promise<void>((resolve) => {
    finishPreparation = resolve;
  });
  const request = fixture("paused", preparation, true);
  await screen.findByRole("button", { name: "Resume preparation" });
  fireEvent.click(screen.getByRole("button", { name: "Resume preparation" }));
  await screen.findByRole("button", { name: "Pause preparation" });
  expect(screen.queryByRole("group", { name: "Review filters" })).not.toBeInTheDocument();
  await act(async () => {
    finishPreparation();
    await preparation;
  });
  await screen.findByText("ChatGPT review", {}, { timeout: 4000 });
  expect(request.mock.calls.filter(([url]) => url.endsWith("/prepare"))).toHaveLength(1);
  expect(request.mock.calls.find(([url]) => url.endsWith("/prepare"))?.[1]?.body).toBe(
    JSON.stringify({
      session_id: "scope",
      review_after_prepare: true,
      auto_correct: false,
      max_requests: 100,
    }),
  );
  expect(request.mock.calls.some(([url]) => url.endsWith("/start"))).toBe(false);
  expect(screen.queryByRole("textbox", { name: "Correct reading" })).not.toBeInTheDocument();
});

it("requires an explicit larger cumulative limit and resumes the same exhausted job", async () => {
  const request = fixture("failed", undefined, false, false, { limit: 175, requests: 175 });
  await screen.findByRole("button", { name: "Resume review" });
  const limit = screen.getByRole("spinbutton", { name: "Request limit" });
  expect(limit).toHaveValue(175);
  expect(screen.getByRole("button", { name: "Auto-correction disabled" })).toBeEnabled();
  const posts = () => request.mock.calls.filter(([, options]) => options?.method === "POST");
  expect(posts()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Resume review" }));
  await screen.findByText("Increase the request limit before resuming.");
  expect(posts()).toHaveLength(0);
  for (const value of ["", "0", "1.5", "10001"]) {
    fireEvent.change(limit, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Resume review" }));
    await screen.findByText("Request limit must be an integer from 1 to 10000.");
    expect(posts()).toHaveLength(0);
  }
  fireEvent.change(limit, { target: { value: "240" } });
  expect(posts()).toHaveLength(0);
  expect(screen.queryByRole("region", { name: "Review queue" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Resume review" }));
  await screen.findByRole("button", { name: "Pause review" });
  expect(
    posts().map(([url, options]) => ({
      url,
      body: JSON.parse(typeof options?.body === "string" ? options.body : "{}") as unknown,
    })),
  ).toEqual([
    {
      url: "/api/gameplay/ai/resume",
      body: { job_id: "durable-run", max_requests: 240 },
    },
  ]);
  expect(screen.queryByRole("region", { name: "Review queue" })).not.toBeInTheDocument();
});

it("preserves request-limit and auto-correction drafts across remount without replacing native settings", async () => {
  fixture("failed", undefined, false, false, { limit: 175, requests: 175 });
  await screen.findByRole("button", { name: "Resume review" });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Request limit" }), {
    target: { value: "320" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Auto-correction disabled" }));
  cleanup();
  const request = fixture("failed", undefined, false, false, { limit: 175, requests: 175 });
  await screen.findByRole("button", { name: "Resume review" });
  expect(screen.getByRole("spinbutton", { name: "Request limit" })).toHaveValue(320);
  expect(screen.getByRole("button", { name: "Auto-correction enabled" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

it("sends a lowered paused-job limit on Resume without preparation or changing correction snapshot", async () => {
  const request = fixture("cancelled", undefined, false, false, { limit: 10000, requests: 65 });
  await screen.findByRole("button", { name: "Resume review" });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Request limit" }), {
    target: { value: "650" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Auto-correction (enabled|disabled)/ }));
  fireEvent.click(screen.getByRole("button", { name: "Resume review" }));
  await screen.findByRole("button", { name: "Pause review" });
  const posts = request.mock.calls.filter(([, options]) => options?.method === "POST");
  expect(
    posts.map(([url, options]) => ({
      url,
      body: JSON.parse(typeof options?.body === "string" ? options.body : "{}") as unknown,
    })),
  ).toEqual([
    { url: "/api/gameplay/ai/resume", body: { job_id: "durable-run", max_requests: 650 } },
  ]);
});

it("retains the recovery source after pausing and remounting preparation with a lower budget", async () => {
  fixture("preparing", undefined, false, false, undefined, "paid-source-job");
  await screen.findByRole("button", { name: "Pause preparation" });
  fireEvent.click(screen.getByRole("button", { name: "Pause preparation" }));
  await screen.findByRole("button", { name: "Resume preparation" });
  cleanup();

  const request = fixture(
    "paused",
    new Promise(() => {}),
    false,
    false,
    undefined,
    "paid-source-job",
  );
  await screen.findByRole("button", { name: "Resume preparation" });
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  fireEvent.change(screen.getByRole("spinbutton", { name: "Request limit" }), {
    target: { value: "8" },
  });
  const autoCorrect =
    screen
      .getByRole("button", { name: /Auto-correction (enabled|disabled)/ })
      .getAttribute("aria-pressed") === "true";
  fireEvent.click(screen.getByRole("button", { name: "Resume preparation" }));
  await screen.findByRole("button", { name: "Pause preparation" });
  const posts = request.mock.calls.filter(([, options]) => options?.method === "POST");
  expect(posts).toHaveLength(1);
  expect(posts[0]?.[0]).toBe("/api/gameplay/ai/prepare");
  const body = posts[0]?.[1]?.body;
  expect(JSON.parse(typeof body === "string" ? body : "{}") as unknown).toEqual({
    session_id: "scope",
    review_after_prepare: true,
    auto_correct: autoCorrect,
    max_requests: 8,
    recover_from_job_id: "paid-source-job",
  });
});

it("explicitly rechecks a paused run with a quarantined candidate instead of losing paid recovery", async () => {
  const request = fixture(
    "paused",
    new Promise(() => {}),
    false,
    false,
    undefined,
    undefined,
    "paid-source-job",
  );
  await screen.findByRole("button", { name: "Recheck review" });
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  fireEvent.change(screen.getByRole("spinbutton", { name: "Request limit" }), {
    target: { value: "8" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Recheck review" }));
  await screen.findByRole("button", { name: "Pause preparation" });
  const posts = request.mock.calls.filter(([, options]) => options?.method === "POST");
  expect(posts).toHaveLength(1);
  expect(posts[0]?.[0]).toBe("/api/gameplay/ai/prepare");
  const body = posts[0]?.[1]?.body;
  expect(JSON.parse(typeof body === "string" ? body : "{}") as unknown).toMatchObject({
    max_requests: 8,
    review_after_prepare: true,
    recover_from_job_id: "paid-source-job",
  });
});

it.each(["explicit refresh", "poll recovery"])(
  "recovers a transient status failure through %s without posting",
  async (recovery) => {
    const request = fixture("running", undefined, true);
    await screen.findByText("ChatGPT review", { exact: true });
    const original = request.getMockImplementation()!;
    let locked = true;
    request.mockImplementation((url, options) => {
      if (url.includes("/status?") && locked)
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ error: "database is locked" }),
        });
      return original(url, options).then(async (response) => {
        if (!url.includes("/status?")) return response;
        const body = (await response.json()) as {
          job: { state: string; usage: { requests: number }; counts: { total: number } };
        };
        body.job.state = "completed";
        body.job.usage.requests = 532;
        body.job.counts.total = 1974;
        return { ...response, json: () => Promise.resolve(body) };
      });
    });
    await screen.findByRole("alert", {}, { timeout: 4000 });
    expect(screen.getByRole("alert")).toHaveTextContent("database is locked");
    expect(screen.queryByRole("region", { name: "Review queue" })).not.toBeInTheDocument();
    expect(request.mock.calls.some(([url]) => url.includes("/items?"))).toBe(false);
    locked = false;
    if (recovery === "explicit refresh")
      fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
    await screen.findByRole("group", { name: "Card suit" }, { timeout: 4000 });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/532 requests/)).toBeInTheDocument();
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    const reads = request.mock.calls.filter(([url]) => url.includes("/items?")).length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
    await waitFor(() => {
      expect(request.mock.calls.filter(([url]) => url.includes("/items?")).length).toBeGreaterThan(
        reads,
      );
    });
  },
);

it("preserves a manual conflict across successful status refresh", async () => {
  const request = fixture("completed", undefined, true);
  await screen.findByRole("group", { name: "Card suit" });
  const original = request.getMockImplementation()!;
  request.mockImplementation((url, options) =>
    url.endsWith("/review")
      ? Promise.resolve({
          ok: false,
          status: 409,
          json: () => Promise.resolve({ error: "Reading changed; reload before correcting" }),
        })
      : original(url, options),
  );
  fireEvent.click(screen.getByRole("button", { name: "Clubs (c)" }));
  fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
  await screen.findByRole("alert");
  const reads = request.mock.calls.filter(([url]) => url.includes("/status?")).length;
  fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
  await waitFor(() => {
    expect(request.mock.calls.filter(([url]) => url.includes("/status?")).length).toBeGreaterThan(
      reads,
    );
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Reading changed; reload before correcting");
});

it("coalesces refresh clicks during a status request and aborts on unmount", async () => {
  const request = fixture("running");
  await screen.findByText("ChatGPT review", { exact: true });
  const original = request.getMockImplementation()!;
  let finish = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let statusReads = 0;
  request.mockImplementation((url, options) => {
    if (!url.includes("/status?")) return original(url, options);
    statusReads++;
    return statusReads === 1 ? pending.then(() => original(url, options)) : original(url, options);
  });
  const refresh = screen.getByRole("button", { name: "Refresh review" });
  for (let i = 0; i < 10; i++) fireEvent.click(refresh);
  expect(statusReads).toBe(1);
  await act(async () => {
    finish();
    await pending;
  });
  await waitFor(() => {
    expect(statusReads).toBe(2);
  });
  const signal = request.mock.calls.filter(([url]) => url.includes("/status?")).at(-1)?.[1]?.signal;
  cleanup();
  expect(signal?.aborted).toBe(true);
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

it.each([0, 3])(
  "completed scope with %s pending groups never offers or posts Start on refresh/remount",
  async (pending) => {
    const request = fixture("completed", undefined, true);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (url, options) => {
      const response = await original(url, options);
      const body = (await response.json()) as {
        job: { counts: Record<string, number>; group_counts: Record<string, number> };
        items: Record<string, unknown>[];
        total: number;
      };
      if (url.includes("/status?")) {
        body.job.group_counts = { ...body.job.counts, total: pending, pending };
      }
      return { ...response, json: () => Promise.resolve(body) };
    });
    await screen.findByRole("group", { name: "Card suit" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
    await screen.findByText(`${pending} groups remaining${pending ? ` · ${pending} pending` : ""}`);
    expect(
      screen.queryByRole("button", { name: /Start review|Resume review|Process new frames/ }),
    ).not.toBeInTheDocument();
    cleanup();
    render(
      <LabQueryProvider>
        <GameplayAiReview sessionId="scope" frameCount={999} active />
      </LabQueryProvider>,
    );
    await screen.findByText("AI complete");
    fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
    await waitFor(() => {
      expect(request.mock.calls.filter(([url]) => url.includes("/status?")).length).toBeGreaterThan(
        2,
      );
    });
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    expect(
      screen.queryByRole("button", { name: /Start review|Resume review|Process new frames/ }),
    ).not.toBeInTheDocument();
  },
);

function manualQueueFixture(retainReviewedGroup = false) {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(540);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(540);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  const request = fixture("completed", undefined, true);
  const original = request.getMockImplementation()!;
  let rows: Record<string, unknown>[] = [];
  let hold: Promise<void> | undefined;
  let failStatus = false;
  let statusDelay: Promise<void> | undefined;
  let itemsDelay: Promise<void> | undefined;
  const revisions: number[] = [];
  request.mockImplementation(async (url, options) => {
    if (url.endsWith("/review")) {
      const body = JSON.parse(typeof options?.body === "string" ? options.body : "{}") as {
        expected_revision: number;
        occurrence_id: string;
        action: string;
        label: string;
      };
      revisions.push(body.expected_revision);
      await hold;
      const row = rows.find((row) => row.id === body.occurrence_id)!;
      if (body.expected_revision !== row.revision)
        return {
          ok: false,
          status: 409,
          json: () => Promise.resolve({ error: "Reading changed; reload before correcting" }),
        };
      Object.assign(row, {
        state: body.action,
        label: body.label,
        revision: Number(row.revision) + 1,
      });
      return {
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            item: row,
            revision: row.revision,
            affected_count: retainReviewedGroup ? 6 : 1,
          }),
      };
    }
    if (url.includes("/status?") && failStatus) throw new Error("Saved status unavailable");
    const response = await original(url, options);
    const body = (await response.json()) as {
      job: { counts: Record<string, number>; group_counts: Record<string, number> };
      items: Record<string, unknown>[];
      total: number;
    };
    if (url.includes("/items?")) {
      if (!rows.length)
        rows = Array.from({ length: 3 }, (_, i) => ({
          ...body.items[0],
          id: `crop-${i}`,
          work_key: `group-${i}`,
          occurrence_count: 1,
          frame_id: `frame-${i}`,
          label: ["c", "h", "s"][i],
          revision: 0,
        }));
      const filter = new URL(url, "http://localhost").searchParams.get("filter");
      const projectedRows = rows.map((row) =>
        retainReviewedGroup && row.state === "manual" ? { ...row, state: "conflict" } : row,
      );
      body.items = projectedRows
        .filter(
          (row) =>
            filter === "all" ||
            (filter === "completed" ? row.state === "manual" : row.state === "conflict"),
        )
        .map((row) => ({ ...row }));
      body.total = body.items.length;
    }
    if (url.includes("/status?"))
      body.job.group_counts = {
        ...body.job.counts,
        total: 3,
        pending: 0,
        manual: retainReviewedGroup ? 0 : rows.filter((row) => row.state === "manual").length,
        needs_review: retainReviewedGroup
          ? 3
          : rows.length
            ? rows.filter((row) => row.state === "conflict").length
            : 3,
      };
    if (url.includes("/status?")) await statusDelay;
    if (url.includes("/items?")) await itemsDelay;
    return { ...response, json: () => Promise.resolve(body) };
  });
  return {
    request,
    revisions,
    delayItems: (promise?: Promise<void>) => {
      itemsDelay = promise;
    },
    delayStatus: (promise?: Promise<void>) => {
      statusDelay = promise;
    },
    delay: (promise: Promise<void>) => {
      hold = promise;
    },
    failStatus: (value: boolean) => {
      failStatus = value;
    },
  };
}

it("keeps completed queue and counts pending save, advances to next surviving group, and uses its revision", async () => {
  const queue = manualQueueFixture();
  await screen.findByRole("textbox", { name: "Correct reading" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
  await screen.findByText("3 groups remaining");
  let release = () => {};
  queue.delay(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
  expect(screen.getByText("AI complete")).toBeInTheDocument();
  expect(screen.getByText("3 groups remaining")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Correct reading" })).toHaveValue("c");
  expect(screen.getByRole("textbox", { name: "Correct reading" })).toHaveValue("c");
  act(() => {
    release();
  });
  await screen.findByText("2 groups remaining");
  expect(screen.getByRole("textbox", { name: "Correct reading" })).toHaveValue("h");
  fireEvent.click(screen.getByRole("button", { name: "Verified 1 groups" }));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Correct reading" })).toHaveValue("c");
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
  await waitFor(() => {
    expect(queue.revisions).toEqual([0, 1]);
  });
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Save and next" })).toBeEnabled();
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
  await waitFor(() => {
    expect(queue.revisions).toEqual([0, 1, 2]);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    queue.request.mock.calls
      .filter(([, options]) => options?.method)
      .every(([url]) => url.endsWith("/review")),
  ).toBe(true);
});

it("retains acknowledged save and coherent queue after a status-read failure until GET retry", async () => {
  const queue = manualQueueFixture();
  await screen.findByRole("textbox", { name: "Correct reading" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
  await screen.findByText("3 groups remaining");
  queue.failStatus(true);
  fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
  await screen.findByText("1 occurrence updated");
  await screen.findByText("Saved status unavailable");
  expect(screen.getByText("3 groups remaining")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Correct reading" })).toHaveValue("c");
  expect(screen.queryByText("No crops")).not.toBeInTheDocument();
  queue.failStatus(false);
  fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
  await screen.findByText("2 groups remaining");
  await waitFor(() => {
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  expect(queue.revisions).toEqual([0]);
});

it("does not enable paid action after the first status read fails", async () => {
  const request = vi
    .fn<(url: string, options?: RequestInit) => Promise<never>>()
    .mockRejectedValue(new Error("Status unavailable"));
  vi.stubGlobal("fetch", request);
  render(
    <LabQueryProvider>
      <GameplayAiReview sessionId="scope" frameCount={3} active />
    </LabQueryProvider>,
  );
  await screen.findByText("Review unavailable");
  expect(screen.getByRole("button", { name: "Start review" })).toBeDisabled();
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

it.each(["status", "items"])(
  "releases approval after committed POST and ignores delayed %s from before the next approval",
  async (delayedRead) => {
    const queue = manualQueueFixture();
    await screen.findByRole("textbox", { name: "Correct reading" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
    await screen.findByText("3 groups remaining");
    let releaseStatus = () => {};
    const delayed = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    if (delayedRead === "status") queue.delayStatus(delayed);
    else queue.delayItems(delayed);
    const reads = queue.request.mock.calls.filter(([url]) =>
      url.includes(`/${delayedRead}?`),
    ).length;
    fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
    await screen.findByText("1 occurrence updated");
    expect(screen.getByText("3 groups remaining")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save and next" })).toBeEnabled();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Review community_cards[1].suit in frame frame-1" }),
    );
    expect(screen.getByRole("textbox", { name: "Correct reading" })).toHaveValue("h");
    await waitFor(() => {
      expect(
        queue.request.mock.calls.filter(([url]) => url.includes(`/${delayedRead}?`)).length,
      ).toBeGreaterThan(reads);
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Correct reading" }), {
      target: { value: "d" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
    await waitFor(() => {
      expect(queue.revisions).toEqual([0, 0]);
    });
    expect(screen.getByText("3 groups remaining")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save and next" })).toBeEnabled();
    });
    expect(screen.getByRole("textbox", { name: "Correct reading" })).toHaveValue("d");
    queue.delayStatus();
    queue.delayItems();
    await act(async () => {
      releaseStatus();
      await delayed;
    });
    await waitFor(() => {
      expect(
        queue.request.mock.calls.filter(([url]) => url.includes(`/${delayedRead}?`)).length,
      ).toBeGreaterThan(reads + 1);
      expect(screen.getByText("1 groups remaining")).toBeInTheDocument();
    });
    expect(screen.getByRole("textbox", { name: "Correct reading" })).toHaveValue("s");
    expect(queue.revisions).toEqual([0, 0]);
    expect(
      queue.request.mock.calls
        .filter(([, options]) => options?.method)
        .every(([url]) => url.endsWith("/review")),
    ).toBe(true);
  },
);

it("does not infer group membership or counts from six acknowledged occurrences", async () => {
  const queue = manualQueueFixture(true);
  await screen.findByRole("textbox", { name: "Correct reading" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
  await screen.findByText("3 groups remaining");
  let release = () => {};
  queue.delayStatus(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
  await screen.findByText("6 occurrences updated");
  expect(screen.getByText("3 groups remaining")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Verified 0 groups" })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Review community_cards[1].suit in frame frame-0" }),
  ).toHaveAttribute("aria-pressed", "true");
  queue.delayStatus();
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(
      queue.request.mock.calls.filter(([url]) => url.includes("/items?")).length,
    ).toBeGreaterThan(2);
  });
  expect(screen.getByText("3 groups remaining")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Save and next" })).toBeEnabled();
  });
  expect(screen.getByText("3 groups remaining")).toBeInTheDocument();
  expect(queue.revisions).toEqual([0]);
});

it("uses previous surviving group and confirms the last empty queue from grouped readback", async () => {
  manualQueueFixture();
  await screen.findByRole("textbox", { name: "Correct reading" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
  await screen.findByText("3 groups remaining");
  fireEvent.click(
    screen.getByRole("button", { name: "Review community_cards[1].suit in frame frame-2" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
  await screen.findByText("2 groups remaining");
  expect(screen.getByRole("textbox", { name: "Correct reading" })).toHaveValue("h");
  fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
  await screen.findByText("1 groups remaining");
  expect(screen.getByRole("textbox", { name: "Correct reading" })).toHaveValue("c");
  fireEvent.click(screen.getByRole("button", { name: "Save and next" }));
  await screen.findByText("0 groups remaining");
  expect(screen.getByRole("button", { name: "Verified 3 groups" })).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Correct reading" })).not.toBeInTheDocument();
});
