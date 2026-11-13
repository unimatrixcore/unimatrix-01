import { invoke as nativeInvoke, isTauri } from "@tauri-apps/api/core";
import { pokerAssistantResponses } from "@unimatrix/shared";

export type AssistantTestInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;
declare global {
  interface Window {
    __ORIGINAL_ASSISTANT_TEST_INVOKE__?: AssistantTestInvoke;
  }
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!(command in pokerAssistantResponses)) throw new Error("Unknown assistant command.");
  const schema = pokerAssistantResponses[command as keyof typeof pokerAssistantResponses];
  const result =
    import.meta.env.MODE === "test-browser" && window.__ORIGINAL_ASSISTANT_TEST_INVOKE__
      ? await window.__ORIGINAL_ASSISTANT_TEST_INVOKE__(command, args)
      : isTauri()
        ? await nativeInvoke<unknown>(command, args)
        : await Promise.reject(new Error("Open Poker Assistant in its desktop window."));
  return schema.parse(result) as T;
}
