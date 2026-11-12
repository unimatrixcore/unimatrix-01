import { afterEach, expect, it, vi } from "vitest";
import { launcherRequest } from "../src/lib/launcher.js";
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
