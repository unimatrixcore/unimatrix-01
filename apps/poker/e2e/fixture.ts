import type { PokerLabRequest } from "@unimatrix/shared";

export function installLabFixture() {
  const worktrees = [
    {
      id: "/fixture/current",
      path: "/fixture/current",
      branch: "work/current",
      head: "a".repeat(40),
    },
    { id: "/fixture/other", path: "/fixture/other", branch: "work/other", head: "b".repeat(40) },
  ];
  let selection = "latest";
  window.__POKER_LAUNCHER_TEST_INVOKE__ = async (operation, selected) => {
    await Promise.resolve();
    if (operation === "select" && selected) selection = selected;
    return {
      selection,
      current: worktrees[0],
      desired: selection === worktrees[1]?.id ? worktrees[1] : worktrees[0],
      worktrees,
      error: null,
    };
  };
  const datasets = [
    { id: "fixture", name: "Fixture dataset", archived: false },
    { id: "archived", name: "Archived fixture", archived: true },
  ];
  let active = "fixture";
  const emptySummary = { total: 0, pending: 0, reviewed: 0, captures: 0, revision: 0 };
  const sessions: Record<string, unknown> = {};
  window.__POKER_LAB_TEST_INVOKE__ = async (request: PokerLabRequest) => {
    await Promise.resolve();
    const success = (body: unknown) => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body,
    });
    const body =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};
    if (request.path === "/api/datasets") {
      if (request.method === "POST") {
        const dataset = {
          id: `dataset-${datasets.length}`,
          name: String(body.name),
          archived: false,
        };
        datasets.push(dataset);
        return success({ dataset });
      }
      return success({ datasets, default_dataset_id: active });
    }
    if (request.path.startsWith("/api/datasets/")) {
      const dataset = datasets.find((value) => value.id === request.path.split("/").at(-1));
      if (dataset) {
        if (request.method === "DELETE") dataset.archived = true;
        else if (typeof body.name === "string") dataset.name = body.name;
        else if (typeof body.archived === "boolean") dataset.archived = body.archived;
      }
      return success({ success: true });
    }
    if (request.headers["x-dataset-id"]) active = request.headers["x-dataset-id"];
    if (request.path === "/api/sync_status")
      return success({ is_syncing: false, current_action: "Ready", progress: 0, total: 0 });
    if (request.path === "/api/initial_data")
      return success({
        session: sessions[active] || {
          queue_mode: "paged",
          frames: [],
          pool: [],
          queue_summary: emptySummary,
        },
        collection_page: { items: [], next_cursor: null, summary: emptySummary },
        db: [],
        sources: [{ name: "TEST-1", label: "TEST-1", kind: "monitor", width: 1920, height: 1080 }],
        monitors: [{ name: "TEST-1", width: 1920, height: 1080 }],
        settings: { last_monitor: "TEST-1" },
        history: [],
      });
    if (request.path === "/api/queue")
      return success({ items: [], next_cursor: null, summary: emptySummary });
    if (request.path === "/api/save_session_progress") {
      sessions[active] = request.body;
      return success({ success: true });
    }
    if (request.path === "/api/save_settings" || request.path === "/api/ai-review/config")
      return success({ configured: false, model: "gpt-4.1", batch_size: 12, success: true });
    if (request.path === "/api/model_status") return success({ state: "ready", available: true });
    if (request.path === "/api/sources")
      return success({
        sources: [{ name: "TEST-1", label: "TEST-1", kind: "monitor", width: 1920, height: 1080 }],
      });
    if (request.path === "/api/gameplay/sources")
      return success({ sources: [{ name: "TEST-1", label: "TEST-1", kind: "monitor" }] });
    if (request.path === "/api/gameplay") return success({ sessions: [] });
    if (request.path === "/api/capture")
      return {
        status: 400,
        headers: { "content-type": "application/json" },
        body: { error: "Fixture capture has no live table." },
      };
    if (request.path === "/api/watch/start")
      return success({ lease_id: "fixture-lease", status: "watching" });
    if (request.path === "/api/watch/tick")
      return success({ status: "duplicate", frames: [], summary: emptySummary });
    if (request.path === "/api/watch/stop") return success({ status: "stopped", success: true });
    if (request.path === "/api/watch/inbox" || request.path === "/api/watch/claim")
      return success({ frames: [], summary: emptySummary });
    return {
      status: 404,
      headers: { "content-type": "application/json" },
      body: { error: `Unhandled test endpoint: ${request.path}` },
    };
  };
}
