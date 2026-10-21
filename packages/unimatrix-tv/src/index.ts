import { createBootGate } from "./loading-gate.js";
import { getClientConfig, installJellyfinAdapter } from "./jellyfin-adapter.js";

export { createBootGate, type BootGate, type BootGateOptions } from "./loading-gate.js";
export { installJellyfinAdapter } from "./jellyfin-adapter.js";

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const gate =
    window.__unimatrixTVBoot ??
    (!getClientConfig().bootGate
      ? { begin(): void {}, ready(): void {}, fail(): void {} }
      : createBootGate());
  window.__unimatrixTVBoot = gate;
  gate.begin();
  function install(): void {
    try {
      installJellyfinAdapter(gate);
    } catch {
      gate.fail();
    }
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
}
