import { invoke, isTauri } from "@tauri-apps/api/core";
import { pokerLauncherStatusSchema, type PokerLauncherStatus } from "@unimatrix/shared";

declare global {
  interface Window {
    __POKER_LAUNCHER_TEST_INVOKE__?: (
      operation: "status" | "select",
      selection?: string,
    ) => Promise<unknown>;
  }
}
export async function launcherRequest(
  operation: "status" | "select",
  selection?: string,
): Promise<PokerLauncherStatus> {
  if (isTauri())
    return pokerLauncherStatusSchema.parse(
      await invoke("launcher_request", { operation, selection }),
    );
  if (import.meta.env.MODE === "test-browser" && window.__POKER_LAUNCHER_TEST_INVOKE__)
    return pokerLauncherStatusSchema.parse(
      await window.__POKER_LAUNCHER_TEST_INVOKE__(operation, selection),
    );
  throw new Error("Branch selection is available in the desktop app");
}
