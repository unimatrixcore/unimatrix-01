import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBootGate } from "../src/loading-gate.js";

describe("createBootGate", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("mounts the loading gate and sets pending class on begin()", () => {
    const gate = createBootGate({ transitionMs: 10 });
    gate.begin();

    expect(document.documentElement.classList.contains("utv-boot-pending")).toBe(true);
    const gateEl = document.getElementById("utv-boot-gate");
    expect(gateEl).not.toBeNull();
    expect(gateEl?.getAttribute("role")).toBe("status");
    expect(gateEl?.getAttribute("aria-live")).toBe("polite");
    expect(gateEl?.textContent).toContain("Loading your library");
  });

  it("removes pending class and cleans up gate on ready()", () => {
    vi.useFakeTimers();
    const gate = createBootGate({ transitionMs: 50 });
    gate.begin();

    expect(document.documentElement.classList.contains("utv-boot-pending")).toBe(true);
    gate.ready();

    expect(document.documentElement.classList.contains("utv-boot-pending")).toBe(false);
    const gateEl = document.getElementById("utv-boot-gate");
    expect(gateEl?.style.opacity).toBe("0");

    vi.advanceTimersByTime(55);
    expect(document.getElementById("utv-boot-gate")).toBeNull();
  });

  it("dismisses gate on fail() gracefully", () => {
    vi.useFakeTimers();
    const gate = createBootGate({ transitionMs: 50 });
    gate.begin();
    gate.fail();

    expect(document.documentElement.classList.contains("utv-boot-pending")).toBe(false);
    vi.advanceTimersByTime(55);
    expect(document.getElementById("utv-boot-gate")).toBeNull();
  });

  it("does not mount gate if playback is detected", () => {
    const video = document.createElement("video");
    document.body.appendChild(video);

    const gate = createBootGate({ transitionMs: 10 });
    gate.begin();

    expect(document.documentElement.classList.contains("utv-boot-pending")).toBe(false);
    expect(document.getElementById("utv-boot-gate")).toBeNull();
  });

  it("does not re-mount gate on subsequent begin() after boot completes", () => {
    vi.useFakeTimers();
    const gate = createBootGate({ transitionMs: 10 });
    gate.begin();
    gate.ready();
    vi.advanceTimersByTime(15);

    // Call begin() a second time (e.g. from route change or video play)
    gate.begin();

    expect(document.documentElement.classList.contains("utv-boot-pending")).toBe(false);
    expect(document.getElementById("utv-boot-gate")).toBeNull();
  });
});
