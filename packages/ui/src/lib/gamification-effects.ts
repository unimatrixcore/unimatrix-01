export type GamificationFeedbackKind =
  | "typing"
  | "tab"
  | "discard"
  | "quick"
  | "auto"
  | "correction"
  | "delete"
  | "name_bonus"
  | "penalty";

export interface GamificationFeedback {
  points: number | string;
  kind?: GamificationFeedbackKind;
  glyph?: string;
  multiplier?: number;
}

export interface GamificationEffectsOptions {
  maxVisible?: number;
  maxQueued?: number;
  lifetimeMs?: number;
  staggerMs?: number;
  reducedMotion?: boolean | (() => boolean);
}

export interface GamificationEffects {
  emit: (feedback: GamificationFeedback) => void;
  clear: () => void;
  dispose: () => void;
}

const symbols: Record<GamificationFeedbackKind, string> = {
  typing: "",
  tab: "TAB",
  discard: "⌫",
  quick: "ϟ",
  auto: "◷",
  correction: "✎",
  delete: "⌫",
  name_bonus: "★",
  penalty: "!",
};

export function getGamificationFeedbackColor(points: number | string): string {
  const number = typeof points === "number" ? points : Number(points.match(/-?\d+/)?.[0] ?? 0);
  if (number < 0) return "var(--destructive)";
  if (number <= 10) return "var(--muted-foreground)";
  if (number <= 25) return "var(--foreground)";
  if (number >= 500) return "var(--chart-2)";
  if (number >= 200) return "var(--chart-3)";
  return "var(--primary)";
}

export function formatGamificationPoints(points: number | string): string {
  return typeof points === "number" && points > 0 ? `+${points}` : String(points);
}

export function gamificationFeedbackSymbol(feedback: GamificationFeedback): string {
  return feedback.kind === "typing"
    ? feedback.glyph === " "
      ? "_"
      : (feedback.glyph ?? "")
    : feedback.kind
      ? symbols[feedback.kind]
      : "";
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(1, Math.floor(value!))) : fallback;
}

/** Own one layer per input or game surface; clear it when the consumer changes context. */
export function createGamificationEffects(
  container: HTMLElement,
  options: GamificationEffectsOptions = {},
): GamificationEffects {
  const document = container.ownerDocument;
  const window = document.defaultView;
  const layer = document.createElement("div");
  layer.className = "um-game-effects";
  layer.setAttribute("aria-hidden", "true");
  container.appendChild(layer);
  const receipt = document.createElement("span");
  receipt.className = "um-game-receipt";
  receipt.setAttribute("role", "status");
  receipt.setAttribute("aria-live", "polite");
  receipt.setAttribute("aria-atomic", "true");
  container.appendChild(receipt);
  const maxVisible = bounded(options.maxVisible, 16, 64);
  const maxQueued = bounded(options.maxQueued, 32, 128);
  const lifetime = bounded(options.lifetimeMs, 1200, 5000);
  const stagger = bounded(options.staggerMs, 60, 500);
  const queue: GamificationFeedback[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  let draining = false;
  const reduced = (): boolean =>
    typeof options.reducedMotion === "function"
      ? options.reducedMotion()
      : (options.reducedMotion ??
        window?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
        false);
  const later = (callback: () => void, delay: number): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
  };
  const draw = (feedback: GamificationFeedback): void => {
    if (feedback.kind !== "typing")
      receipt.textContent =
        `${gamificationFeedbackSymbol(feedback)} ${formatGamificationPoints(feedback.points)}`.trim();
    if (reduced() && feedback.kind === "typing") return;
    const item = document.createElement("div");
    item.className = "um-game-feedback";
    item.dataset.kind = feedback.kind ?? "score";
    item.dataset.motion = reduced() ? "reduced" : "full";
    item.dataset.magnitude =
      typeof feedback.points === "number" && Math.abs(feedback.points) <= 10 ? "small" : "large";
    item.style.color = getGamificationFeedbackColor(feedback.points);
    item.style.left = `${25 + Math.random() * 50}%`;
    item.style.top = `${Math.random() * 10}%`;
    item.style.setProperty("--um-game-rotation", `${Math.random() * 24 - 12}deg`);
    item.style.setProperty("--um-game-lifetime", `${lifetime}ms`);
    const symbol = document.createElement("span");
    symbol.className = "um-game-feedback-symbol";
    symbol.textContent = gamificationFeedbackSymbol(feedback);
    const value = document.createElement("span");
    value.className = "um-game-feedback-points";
    value.textContent = formatGamificationPoints(feedback.points);
    item.append(symbol, value);
    while (layer.childElementCount >= maxVisible) layer.firstElementChild?.remove();
    layer.appendChild(item);
    if (
      !reduced() &&
      (feedback.multiplier ?? 1) >= 5 &&
      (typeof feedback.points !== "number" || feedback.points >= 100)
    ) {
      layer.classList.remove("um-game-burst");
      void layer.offsetWidth;
      layer.classList.add("um-game-burst");
    }
    later(() => {
      item.remove();
    }, lifetime);
  };
  const drain = (): void => {
    if (disposed) return;
    const feedback = queue.shift();
    if (feedback) {
      draw(feedback);
      later(drain, stagger);
    } else draining = false;
  };
  const clear = (): void => {
    queue.length = 0;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    draining = false;
    layer.replaceChildren();
    layer.classList.remove("um-game-burst");
    receipt.textContent = "";
  };
  return {
    emit(feedback): void {
      if (disposed || (typeof feedback.points === "number" && !Number.isFinite(feedback.points)))
        return;
      if (feedback.points === 0 && !feedback.kind) return;
      if (queue.length >= maxQueued) queue.shift();
      queue.push({
        ...feedback,
        ...(feedback.glyph === undefined ? {} : { glyph: feedback.glyph.slice(0, 32) }),
      });
      if (!draining) {
        draining = true;
        drain();
      }
    },
    clear,
    dispose(): void {
      clear();
      disposed = true;
      layer.remove();
      receipt.remove();
    },
  };
}
