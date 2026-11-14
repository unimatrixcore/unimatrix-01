import { afterEach, expect, it, vi } from "vitest";
import { launcherRequest, setLauncherRecording } from "../src/lib/launcher.js";
const native = vi.hoisted(() => ({ enabled: false, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.enabled, invoke: native.invoke }));
afterEach(() => {
  native.enabled = false;
  native.invoke.mockReset();
  delete window.__POKER_LAUNCHER_TEST_INVOKE__;
});
it("rejects browser access even when a native-style test hook exists", async () => {
  window.__POKER_LAUNCHER_TEST_INVOKE__ = vi.fn();
  await expect(launcherRequest("status")).rejects.toThrow("desktop app");
  expect(native.invoke).not.toHaveBeenCalled();
});
it("validates native status and sends only the requested selection", async () => {
  native.enabled = true;
  const status = { selection: "latest", current: null, desired: null, worktrees: [] };
  native.invoke
    .mockResolvedValueOnce(status)
    .mockResolvedValueOnce({ ...status, worktrees: [false] });
  expect(await launcherRequest("select", "latest")).toEqual(status);
  expect(native.invoke).toHaveBeenCalledWith("launcher_request", {
    operation: "select",
    selection: "latest",
  });
  await expect(launcherRequest("status")).rejects.toThrow();
});
it("sends recording intent through the native child and propagates failed protection", async () => {
  await setLauncherRecording("gameplay", true);
  expect(native.invoke).not.toHaveBeenCalled();
  native.enabled = true;
  native.invoke.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error("disk failed"));
  await setLauncherRecording("collector", true);
  expect(native.invoke).toHaveBeenCalledWith("launcher_request", {
    operation: "recording",
    selection: "collector:on",
  });
  await expect(setLauncherRecording("collector", false)).rejects.toThrow("disk failed");
});
it("allows only the exact old-native unsupported operation with one compatibility warning", async () => {
  native.enabled = true;
  const warning = vi.fn();
  window.addEventListener("poker-recording-protection-unavailable", warning);
  native.invoke.mockRejectedValue("Invalid launcher request");
  await setLauncherRecording("gameplay", true);
  await setLauncherRecording("collector", true);
  expect(warning).toHaveBeenCalledTimes(1);
  window.removeEventListener("poker-recording-protection-unavailable", warning);
  native.invoke.mockRejectedValue("Other launcher failure");
  await expect(setLauncherRecording("gameplay", true)).rejects.toBe("Other launcher failure");
});
