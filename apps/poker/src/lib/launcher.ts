import { invoke, isTauri } from "@tauri-apps/api/core";
import { pokerLauncherStatusSchema, type PokerLauncherStatus } from "@unimatrix/shared";

declare global {
  interface Window {
    pokerSetLauncherRecording?: typeof setLauncherRecording;
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

let warnedUnsupportedRecording = false;
export async function setLauncherRecording(
  role: "gameplay" | "collector",
  active: boolean,
): Promise<void> {
  if (!isTauri()) return;
  let response: unknown;
  try {
    response = await invoke("launcher_request", {
      operation: "recording",
      selection: `${role}:${active ? "on" : "off"}`,
    });
  } catch (error) {
    if ((error instanceof Error ? error.message : error) !== "Invalid launcher request")
      throw error;
    if (!warnedUnsupportedRecording) {
      warnedUnsupportedRecording = true;
      window.dispatchEvent(new CustomEvent("poker-recording-protection-unavailable"));
    }
    return;
  }
  if (!response || typeof response !== "object" || !("ok" in response) || response.ok !== true)
    throw new Error("Cannot update recording protection");
}
