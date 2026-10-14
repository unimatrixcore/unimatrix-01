import { createBootGate } from "./loading-gate.js";

if (typeof window !== "undefined" && !window.__unimatrixTVBoot) {
  window.__unimatrixTVBoot = createBootGate({
    logoUrl: (window.__unimatrixTVConfig?.assetsBase ?? "/UnimatrixTV/assets/") + "logo.png",
  });
  window.__unimatrixTVBoot.begin();
}
