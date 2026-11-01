import { beforeEach, describe, expect, it, vi } from "vitest";

import { readStoredValue, readStoredValueFromStorage } from "@/lib/local-storage";
import { enableOnlyLearnedCases, readCasePool, setCaseEnabled } from "@/lib/pool-storage";
import { readPreviewMode, writePreviewMode } from "@/lib/preview-mode-storage";
import { readCaseProgress, setCaseStatus } from "@/lib/progress-storage";

/**
 * The CFLOP rebrand moved every key from the `cube-trainer:` namespace to
 * `cflop:`. Nothing in the app would report a failure if that dropped a user's
 * data — reads would just return the empty default and every case would look
 * unlearned. These tests are the only thing standing between the rename and a
 * silent wipe, so they assert against literal key strings rather than going
 * through the writers: a test that only round-trips through the new prefix
 * passes just as happily when the fallback is deleted.
 */
describe("pre-rebrand localStorage keys", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("reads learned-case progress written under the old prefix", () => {
    window.localStorage.setItem(
      "cube-trainer:progress:oll",
      JSON.stringify({ "oll-1": "known", "oll-2": "learning" }),
    );

    expect(readCaseProgress("oll")).toEqual({ "oll-1": "known", "oll-2": "learning" });
  });

  it("propagates migration read failures while ordinary reads remain best effort", () => {
    const failure = new DOMException("Storage blocked", "SecurityError");
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw failure;
    });
    try {
      expect(() => readStoredValueFromStorage(localStorage, "progress:oll")).toThrow(failure);
      expect(readStoredValue("progress:oll")).toBeNull();
    } finally {
      getItem.mockRestore();
    }
  });

  it("reads a training pool written under the old prefix", () => {
    window.localStorage.setItem("cube-trainer:pool:pll", JSON.stringify({ "pll-ua": false }));

    expect(readCasePool("pll")).toEqual({ "pll-ua": false });
  });

  it("reads a preview-mode preference written under the old prefix", () => {
    window.localStorage.setItem("cube-trainer:preview-mode:drill", "hidden");

    expect(readPreviewMode("drill")).toBe("hidden");
  });

  it("carries legacy progress forward on the next write instead of replacing it", () => {
    window.localStorage.setItem("cube-trainer:progress:oll", JSON.stringify({ "oll-1": "known" }));

    setCaseStatus("oll", "oll-2", "learning");

    // The merge is the point: writing one case must not discard the other 56.
    expect(readCaseProgress("oll")).toEqual({ "oll-1": "known", "oll-2": "learning" });
    expect(window.localStorage.getItem("cflop:progress:oll")).toBe(
      JSON.stringify({ "oll-1": "known", "oll-2": "learning" }),
    );
  });

  it("carries a legacy pool forward on the next write", () => {
    window.localStorage.setItem("cube-trainer:pool:oll", JSON.stringify({ "oll-1": false }));

    setCaseEnabled("oll", "oll-2", false);

    expect(readCasePool("oll")).toEqual({ "oll-1": false, "oll-2": false });
  });

  it("prefers the current key once one exists, and never writes the legacy key", () => {
    window.localStorage.setItem("cube-trainer:progress:oll", JSON.stringify({ "oll-1": "known" }));

    setCaseStatus("oll", "oll-1", "new");

    expect(readCaseProgress("oll")).toEqual({ "oll-1": "new" });
    // The stale legacy key is deliberately left in place rather than deleted,
    // but it must no longer be what reads resolve to.
    expect(window.localStorage.getItem("cube-trainer:progress:oll")).toBe(
      JSON.stringify({ "oll-1": "known" }),
    );
  });

  it("does not fall back when the current key holds malformed data", () => {
    window.localStorage.setItem("cflop:progress:oll", "not valid json");
    window.localStorage.setItem("cube-trainer:progress:oll", JSON.stringify({ "oll-1": "known" }));

    // A present-but-corrupt current value is the authoritative answer. Falling
    // through to the legacy key here would resurrect data the user has since
    // changed.
    expect(readCaseProgress("oll")).toEqual({});
  });

  it("writes a preview-mode preference under the current prefix only", () => {
    writePreviewMode("learn", "two-sided");

    expect(window.localStorage.getItem("cflop:preview-mode:learn")).toBe("two-sided");
    expect(window.localStorage.getItem("cube-trainer:preview-mode:learn")).toBeNull();
  });

  it("writes the drill-pool mode under the current prefix only", () => {
    enableOnlyLearnedCases("oll", {});

    expect(window.localStorage.getItem("cflop:pool-mode:oll")).toBe("only-learned");
    expect(window.localStorage.getItem("cube-trainer:pool-mode:oll")).toBeNull();
  });
});
