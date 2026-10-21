import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBootGate, type BootGate } from "../src/loading-gate.js";

let gate: BootGate;
beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.className = "";
  document.body.innerHTML = "<main id='reactRoot'>Library</main>";
  history.replaceState(null, "", "#/home");
  gate = createBootGate({ transitionMs: 50, timeoutMs: 1000 });
});
afterEach(() => {
  gate.dispose?.();
  vi.useRealTimers();
});

describe("loading gate", () => {
  it("covers the initial library, then reveals a completed page", () => {
    gate.begin();
    expect(document.documentElement.classList.contains("utv-boot-pending")).toBe(true);
    expect(document.getElementById("utv-boot-gate")?.getAttribute("role")).toBe("status");
    gate.ready();
    expect(document.documentElement.classList.contains("utv-boot-pending")).toBe(false);
    vi.advanceTimersByTime(50);
    expect(document.getElementById("utv-boot-gate")).toBeNull();
  });
  it("ignores cached video nodes on non-playback routes", () => {
    document.body.insertAdjacentHTML("beforeend", "<div class='hide'><video></video></div>");
    gate.begin();
    expect(document.documentElement.classList.contains("utv-boot-pending")).toBe(true);
  });
  it("leaves native playback visible", () => {
    history.replaceState(null, "", "#/video");
    gate.begin();
    expect(document.getElementById("utv-boot-gate")).toBeNull();
    expect(document.documentElement.classList.contains("utv-boot-pending")).toBe(false);
  });
  it("shows recovery if the deferred client never becomes ready", () => {
    gate.begin();
    vi.advanceTimersByTime(1000);
    expect(document.documentElement.dataset.utvBoot).toBe("error");
    expect(document.documentElement.classList.contains("utv-boot-pending")).toBe(true);
    expect(document.querySelector("#utv-boot-gate button")?.textContent).toBe("Try again");
    const href = document.querySelector<HTMLAnchorElement>("#utv-boot-gate a")?.href;
    expect(href).toContain("unimatrix=off");
    expect(href).toContain("#/home");
  });
  it("does not remount the full-screen loader on later view changes", () => {
    gate.begin();
    gate.ready();
    history.replaceState(null, "", "#/details?id=movie");
    gate.begin();
    vi.advanceTimersByTime(60);
    expect(document.documentElement.classList.contains("utv-boot-pending")).toBe(false);
    expect(document.documentElement.dataset.utvBoot).toBe("ready");
    expect(document.getElementById("utv-boot-gate")).toBeNull();
    history.replaceState(null, "", "#/movies");
    gate.begin();
    vi.advanceTimersByTime(1500);
    expect(document.getElementById("utv-boot-gate")).toBeNull();
  });
  it("does not cover a loaded app when later adaptation fails", () => {
    gate.begin();
    gate.ready();
    vi.advanceTimersByTime(50);
    history.replaceState(null, "", "#/details?id=movie");
    gate.begin();
    gate.fail();
    expect(document.documentElement.dataset.utvBoot).toBe("ready");
    expect(document.documentElement.classList.contains("utv-boot-pending")).toBe(false);
    expect(document.getElementById("utv-boot-gate")).toBeNull();
  });
  it("does not show a boot screen after opening directly into playback", () => {
    history.replaceState(null, "", "#/video");
    gate.begin();
    history.replaceState(null, "", "#/home");
    gate.begin();
    expect(document.documentElement.classList.contains("utv-boot-pending")).toBe(false);
    expect(document.getElementById("utv-boot-gate")).toBeNull();
  });
  it("repeated lifecycle notifications do not extend a broken page indefinitely", () => {
    gate.begin();
    vi.advanceTimersByTime(600);
    gate.begin();
    vi.advanceTimersByTime(400);
    expect(document.documentElement.dataset.utvBoot).toBe("error");
  });
  it("does not flash a gate when re-observing the same completed route", () => {
    gate.begin();
    gate.ready();
    vi.advanceTimersByTime(50);
    gate.begin();
    expect(document.getElementById("utv-boot-gate")).toBeNull();
  });
  it("keeps the error panel idempotent", () => {
    gate.begin();
    gate.fail();
    gate.fail();
    expect(document.querySelectorAll(".utv-boot-actions")).toHaveLength(1);
    expect(document.querySelector("#utv-boot-gate")?.getAttribute("role")).toBe("alert");
  });
});
