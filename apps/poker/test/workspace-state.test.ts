import { afterEach, expect, it, vi } from "vitest";
import {
  readWorkspaceState,
  rememberWorkspaceState,
  rememberWorkspaceScroll,
  restoreWorkspaceLocation,
  restoreWorkspaceScroll,
} from "../src/lib/workspace-state";

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("restores only the native root launch and honors explicit internal URLs", () => {
  rememberWorkspaceState({ path: "/labeling/244", ocrPath: "/labeling/244" });
  let dispose = restoreWorkspaceLocation();
  expect(location.pathname).toBe("/labeling/244");
  dispose();
  history.replaceState(null, "", "/training");
  dispose = restoreWorkspaceLocation();
  expect(location.pathname).toBe("/training");
  expect(readWorkspaceState()).toMatchObject({ path: "/training", ocrPath: "/labeling/244" });
  dispose();
  history.replaceState(null, "", "/index.html");
  dispose = restoreWorkspaceLocation();
  expect(location.pathname).toBe("/training");
  dispose();
});

it("retains workflow, session, hand and version preferences without arbitrary fields", () => {
  rememberWorkspaceState({
    path: "/gameplay",
    gameplay: { sessionId: "session-2", view: "frames", hand: "hand-4" },
    trainingRun: "version-3",
  });
  rememberWorkspaceScroll("gameplay", { top: 400, left: 0 });
  rememberWorkspaceScroll("training", { top: 200, left: 12 });
  expect(readWorkspaceState()).toEqual({
    path: "/gameplay",
    gameplay: { sessionId: "session-2", view: "frames", hand: "hand-4" },
    trainingRun: "version-3",
    scroll: { gameplay: { top: 400, left: 0 }, training: { top: 200, left: 12 } },
  });
  localStorage.setItem(
    "poker-lab:workspace:v1",
    JSON.stringify({ path: "/review", api_key: "do-not-retain" }),
  );
  rememberWorkspaceState({ trainingRun: "version-4" });
  expect(localStorage.getItem("poker-lab:workspace:v1")).not.toContain("api_key");
});

it("rejects corrupted, oversized, invalid-path and invalid-scroll preferences", () => {
  for (const raw of [
    "{",
    JSON.stringify({ path: "https://example.test" }),
    JSON.stringify({ scroll: { gameplay: { top: -1, left: 0 } } }),
    " ".repeat(4097),
  ]) {
    localStorage.setItem("poker-lab:workspace:v1", raw);
    expect(readWorkspaceState()).toEqual({});
  }
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  expect(readWorkspaceState()).toEqual({});
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  expect(() => {
    rememberWorkspaceState({ path: "/review" });
  }).not.toThrow();
});

it("records only committed route events and the final page-hide location", () => {
  history.replaceState(null, "", "/gameplay");
  const dispose = restoreWorkspaceLocation();
  history.replaceState(null, "", "/training");
  window.dispatchEvent(new Event("poker-workspace-change"));
  expect(readWorkspaceState().path).toBe("/training");
  history.replaceState(null, "", "/database");
  window.dispatchEvent(new Event("poker-ocr-location"));
  expect(readWorkspaceState().ocrPath).toBe("/database");
  history.replaceState(null, "", "/review");
  window.dispatchEvent(new Event("pagehide"));
  expect(readWorkspaceState().path).toBe("/review");
  dispose();
});

function regionFixture() {
  const region = document.createElement("div");
  let height = 100,
    top = 0;
  Object.defineProperties(region, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 100 },
    scrollWidth: { value: 200 },
    clientWidth: { value: 200 },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, height - 100));
      },
    },
  });
  document.body.append(region);
  return {
    region,
    setHeight: (value: number) => {
      height = value;
      region.append(document.createElement("div"));
    },
  };
}

it("waits for asynchronous content before restoring the saved position", async () => {
  const { region, setHeight } = regionFixture(),
    done = vi.fn();
  const cancel = restoreWorkspaceScroll(region, { top: 400, left: 0 }, done);
  expect(region.scrollTop).toBe(0);
  expect(done).not.toHaveBeenCalled();
  setHeight(800);
  await Promise.resolve();
  expect(region.scrollTop).toBe(400);
  expect(done).toHaveBeenCalledOnce();
  cancel();
  expect(done).toHaveBeenCalledOnce();
  region.remove();
});

it("cancels pending restoration when the user scrolls, without a late jump", async () => {
  const { region, setHeight } = regionFixture(),
    done = vi.fn();
  restoreWorkspaceScroll(region, { top: 400, left: 0 }, done);
  region.dispatchEvent(new WheelEvent("wheel"));
  expect(done).toHaveBeenCalledOnce();
  setHeight(800);
  region.scrollTop = 50;
  await Promise.resolve();
  expect(region.scrollTop).toBe(50);
  region.remove();
});

it("bounds restoration when content is gone and supports keyboard cancellation", () => {
  vi.useFakeTimers();
  const first = regionFixture(),
    done = vi.fn();
  restoreWorkspaceScroll(first.region, { top: 400, left: 0 }, done);
  vi.advanceTimersByTime(15000);
  expect(done).toHaveBeenCalledOnce();
  first.region.remove();
  const second = regionFixture(),
    cancelled = vi.fn();
  restoreWorkspaceScroll(second.region, { top: 400, left: 0 }, cancelled);
  second.region.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" }));
  expect(cancelled).toHaveBeenCalledOnce();
  second.region.remove();
});

it("retains bounded Training pane scroll independently of the old outer workspace scroll", () => {
  rememberWorkspaceState({
    trainingPanes: { versions: { top: 130, left: 0 }, "version-6": { top: 420, left: 8 } },
    trainingRun: "version-6",
  });
  expect(readWorkspaceState()).toMatchObject({
    trainingRun: "version-6",
    trainingPanes: { versions: { top: 130, left: 0 }, "version-6": { top: 420, left: 8 } },
  });
  rememberWorkspaceState({ trainingPanes: { invalid: { top: -1, left: 0 } } });
  expect(readWorkspaceState().trainingPanes?.["version-6"]?.top).toBe(420);
});
