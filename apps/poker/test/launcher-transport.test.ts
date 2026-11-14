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

it("allows an explicitly unconfigured supervisor but rejects configured protection failures", async () => {
  native.enabled = true;
  native.invoke.mockResolvedValueOnce({ ok: true, protection: "unconfigured" });
  await expect(setLauncherRecording("gameplay", true)).resolves.toBeUndefined();
  native.invoke.mockRejectedValueOnce("POKER_LAB_LAUNCHER_PATH is unavailable");
  await expect(setLauncherRecording("gameplay", true)).rejects.toBe(
    "POKER_LAB_LAUNCHER_PATH is unavailable",
  );
});

it("serializes each role without blocking the other role or poisoning its queue after failure", async () => {
  native.enabled = true;
  let release!: () => void;
  native.invoke.mockImplementation((_command, args: { selection: string }) =>
    args.selection === "gameplay:off"
      ? new Promise<void>((resolve) => {
          release = resolve;
        }).then(() => ({ ok: true }))
      : Promise.resolve({ ok: true }),
  );
  const off = setLauncherRecording("gameplay", false);
  await vi.waitFor(() => {
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });
  const on = setLauncherRecording("gameplay", true);
  await setLauncherRecording("collector", true);
  expect(
    native.invoke.mock.calls.map((call) => (call[1] as { selection: string }).selection),
  ).toEqual(["gameplay:off", "collector:on"]);
  release();
  await Promise.all([off, on]);
  expect(
    native.invoke.mock.calls.map((call) => (call[1] as { selection: string }).selection),
  ).toEqual(["gameplay:off", "collector:on", "gameplay:on"]);
  native.invoke.mockRejectedValueOnce(new Error("failed update"));
  await expect(setLauncherRecording("collector", false)).rejects.toThrow("failed update");
  native.invoke.mockResolvedValueOnce({ ok: true });
  await expect(setLauncherRecording("collector", true)).resolves.toBeUndefined();
});
