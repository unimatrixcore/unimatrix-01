import { pokerOcrContract, pokerOcrContractSha256 } from "@unimatrix/poker";
import { installLabTransport } from "./lib/native-transport.js";
import "./styles.css";

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
  window.OCR_CONTRACT = pokerOcrContract;
  window.OCR_CONTRACT_SHA256 = pokerOcrContractSha256;
  window.SERVER_START_TIME = Date.now() / 1000;
  if (window.location.pathname === "/gameplay")
    document.getElementById("loading-overlay")?.classList.remove("active");
  await import("./collector/main.js");
  await loadScript("lib/scroll_position");
  if (window.location.pathname !== "/gameplay") {
    for (const module of classicScripts) await loadScript(module);
  }
}
void start().catch((error: unknown) => {
  document.getElementById("loading-overlay")?.classList.remove("active");
  const toast = document.createElement("div");
  toast.className = "toast error";
  toast.textContent = error instanceof Error ? error.message : String(error);
  document.getElementById("toast-container")?.appendChild(toast);
});
