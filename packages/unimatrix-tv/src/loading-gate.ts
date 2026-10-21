import { isPlaybackRoute } from "./playback.js";

export interface BootGate {
  begin(): void;
  ready(): void;
  fail(): void;
  dispose?(): void;
}

export interface BootGateOptions {
  logoUrl?: string;
  loadingText?: string;
  transitionMs?: number;
  timeoutMs?: number;
}

declare global {
  interface Window {
    __unimatrixTVBoot?: BootGate;
    __unimatrixTVConfig?: {
      enabled: boolean;
      bootGate: boolean;
      requestsUrl: string;
      assetsBase: string;
    };
  }
}

export function createBootGate(options: BootGateOptions = {}): BootGate {
  const transitionMs = options.transitionMs ?? 250;
  let screen: HTMLElement | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removal: ReturnType<typeof setTimeout> | undefined;
  let bodyObserver: MutationObserver | undefined;
  let pendingRoute: string | undefined;
  let completed = false;
  let disposed = false;

  function mount(): HTMLElement {
    if (screen?.isConnected) return screen;
    screen = document.getElementById("utv-boot-gate") ?? document.createElement("div");
    screen.id = "utv-boot-gate";
    screen.setAttribute("role", "status");
    screen.setAttribute("aria-live", "polite");
    const card = document.createElement("div");
    card.className = "utv-boot-card";
    const logo = document.createElement("img");
    logo.className = "utv-boot-logo";
    logo.src = options.logoUrl ?? "/UnimatrixTV/assets/logo.png";
    logo.alt = "Unimatrix-TV";
    const spinner = document.createElement("div");
    spinner.className = "utv-boot-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const text = document.createElement("div");
    text.className = "utv-boot-text";
    text.textContent = options.loadingText ?? "Loading";
    card.append(logo, spinner, text);
    screen.replaceChildren(card);
    const node = screen;
    function attach(): void {
      if (!document.body || disposed || node !== screen) return;
      document.body.prepend(node);
      bodyObserver?.disconnect();
      bodyObserver = undefined;
    }
    if (document.body) attach();
    else {
      bodyObserver?.disconnect();
      bodyObserver = new MutationObserver(attach);
      bodyObserver.observe(document.documentElement, { childList: true });
    }
    return screen;
  }

  function dismiss(): void {
    clearTimeout(timeout);
    bodyObserver?.disconnect();
    bodyObserver = undefined;
    document.documentElement.classList.remove("utv-boot-pending");
    document.documentElement.dataset.utvBoot = "ready";
    const node = screen;
    if (!node) return;
    const reduced =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reduced ? 0 : transitionMs;
    node.style.transition = `opacity ${duration}ms ease-out`;
    node.style.opacity = "0";
    node.style.pointerEvents = "none";
    clearTimeout(removal);
    removal = setTimeout(() => {
      node.remove();
      if (screen === node) screen = undefined;
    }, duration);
  }

  const gate: BootGate = {
    begin(): void {
      if (disposed || completed) return;
      if (isPlaybackRoute()) {
        completed = true;
        pendingRoute = undefined;
        dismiss();
        return;
      }
      if (pendingRoute === location.hash) return;
      pendingRoute = location.hash;
      clearTimeout(timeout);
      clearTimeout(removal);
      document.documentElement.classList.add("utv-boot-pending");
      document.documentElement.dataset.utvBoot = "loading";
      mount().removeAttribute("style");
      timeout = setTimeout(() => {
        gate.fail();
      }, options.timeoutMs ?? 25000);
    },
    ready(): void {
      if (disposed) return;
      completed = true;
      pendingRoute = undefined;
      dismiss();
    },
    fail(): void {
      if (disposed || completed) return;
      if (isPlaybackRoute()) {
        dismiss();
        return;
      }
      clearTimeout(timeout);
      clearTimeout(removal);
      pendingRoute = location.hash;
      document.documentElement.classList.add("utv-boot-pending");
      document.documentElement.dataset.utvBoot = "error";
      const node = mount();
      node.setAttribute("role", "alert");
      node.removeAttribute("style");
      const card = node.querySelector(".utv-boot-card");
      const text = node.querySelector(".utv-boot-text");
      if (text) text.textContent = "Couldn't load this page";
      node.querySelector(".utv-boot-spinner")?.remove();
      const actions = document.createElement("div");
      actions.className = "utv-boot-actions";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => {
        location.reload();
      });
      const standard = document.createElement("a");
      const href = new URL(location.href);
      href.searchParams.set("unimatrix", "off");
      standard.href = href.toString();
      standard.textContent = "Standard view";
      actions.append(retry, standard);
      card?.querySelector(".utv-boot-actions")?.remove();
      card?.append(actions);
    },
    dispose(): void {
      disposed = true;
      clearTimeout(timeout);
      clearTimeout(removal);
      bodyObserver?.disconnect();
      screen?.remove();
      document.documentElement.classList.remove("utv-boot-pending");
    },
  };
  return gate;
}
