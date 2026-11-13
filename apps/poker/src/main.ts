import { pokerOcrContract, pokerOcrContractSha256 } from "@unimatrix/poker";
import { installLabTransport } from "./lib/native-transport.js";
import { installOcrBackgroundLists } from "./lib/ocr-background-lists";

const classicScripts = [
  "lib/utils",
  "lib/schemas",
  "lib/ui",
  "lib/scoring",
  "lib/stats",
  "lib/watch_capture",
  "lib/capture_animation",
  "lib/session_review",
  "lib/ai_review",
  "app",
];
function loadScript(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `/static/js/${name}.js`;
    script.onload = () => {
      resolve();
    };
    script.onerror = () => {
      reject(new Error(`Could not load Poker Lab module ${name}.`));
    };
    document.body.appendChild(script);
  });
}
async function start(): Promise<void> {
  installLabTransport();
  installOcrBackgroundLists();
  window.OCR_CONTRACT = pokerOcrContract;
  window.OCR_CONTRACT_SHA256 = pokerOcrContractSha256;
  window.SERVER_START_TIME = Date.now() / 1000;
  await import("./collector/main.js");
  await loadScript("lib/scroll_position");
  if (window.location.pathname !== "/gameplay") {
    for (const module of classicScripts) await loadScript(module);
  }
}
const startupOverlay = document.getElementById("loading-overlay");
const startupWatchdog = window.setTimeout(() => {
  if (!startupOverlay?.classList.contains("active")) return;
  window.pokerStartupTimedOut = true;
  startupOverlay.classList.remove("active");
  const toast = document.createElement("div");
  toast.className = "toast error";
  toast.append("The first view timed out. ");
  const retry = document.createElement("button");
  retry.textContent = "Retry";
  retry.onclick = () => {
    window.location.reload();
  };
  toast.append(retry);
  document.getElementById("toast-container")?.appendChild(toast);
}, 15000);
const startupObserver = new MutationObserver(() => {
  if (!startupOverlay?.classList.contains("active")) {
    clearTimeout(startupWatchdog);
    startupObserver.disconnect();
  }
});
if (startupOverlay)
  startupObserver.observe(startupOverlay, { attributes: true, attributeFilter: ["class"] });
declare global {
  interface Window {
    pokerStartupTimedOut?: boolean;
  }
}
void start().catch((error: unknown) => {
  document.getElementById("loading-overlay")?.classList.remove("active");
  const toast = document.createElement("div");
  toast.className = "toast error";
  toast.textContent = error instanceof Error ? error.message : String(error);
  document.getElementById("toast-container")?.appendChild(toast);
});
