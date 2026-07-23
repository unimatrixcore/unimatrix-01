import { beforeEach, describe, expect, it } from "vitest";

import { readCaseProgress, setCaseStatus } from "@/lib/progress-storage";

describe("progress storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns an empty record when nothing is stored", () => {
    expect(readCaseProgress("oll")).toEqual({});
  });

  it("persists and reads back a case status", () => {
    setCaseStatus("oll", "oll-1", "known");

    expect(readCaseProgress("oll")).toEqual({ "oll-1": "known" });
  });

  it("keeps oll and pll progress separate", () => {
    setCaseStatus("oll", "oll-1", "known");
    setCaseStatus("pll", "pll-ua", "learning");

    expect(readCaseProgress("oll")).toEqual({ "oll-1": "known" });
    expect(readCaseProgress("pll")).toEqual({ "pll-ua": "learning" });
  });

  it("discards malformed stored data instead of throwing", () => {
    window.localStorage.setItem("cube-trainer:progress:oll", "not valid json");
    expect(readCaseProgress("oll")).toEqual({});

    window.localStorage.setItem(
      "cube-trainer:progress:oll",
      JSON.stringify({ "oll-1": "not-a-real-status" }),
    );
    expect(readCaseProgress("oll")).toEqual({});
  });
});
