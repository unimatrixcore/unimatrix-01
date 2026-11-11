import { createModelIcon } from "./model-icon.js";

export type GamificationFeedbackKind =
  | "typing"
  | "tab"
  | "discard"
  | "quick"
  | "auto"
  | "model_accept"
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
  model_accept: "",
  correction: "✎",
  delete: "⌫",
  name_bonus: "★",
  penalty: "!",
};

const feedbackColors: Record<GamificationFeedbackKind, string> = {
  typing: "var(--um-game-feedback-typing, var(--foreground))",
  tab: "var(--um-game-feedback-tab, var(--primary))",
  quick: "var(--um-game-feedback-quick, var(--chart-3))",
  auto: "var(--um-game-feedback-auto, var(--primary))",
  model_accept: "var(--um-game-feedback-model-accept, var(--chart-3))",
  correction: "var(--um-game-feedback-correction, var(--destructive))",
  name_bonus: "var(--um-game-feedback-name, var(--chart-2))",
  delete: "var(--um-game-feedback-delete, var(--destructive))",
  discard: "var(--um-game-feedback-discard, var(--muted-foreground))",
  penalty: "var(--um-game-feedback-penalty, var(--destructive))",
};

export function getGamificationFeedbackColor(
  points: number | string,
  kind?: GamificationFeedbackKind,
): string {
  if (kind) return feedbackColors[kind];
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

export function gamificationFeedbackLabel(feedback: GamificationFeedback): string {
  return `${feedback.kind === "model_accept" ? "Model accepted" : gamificationFeedbackSymbol(feedback)} ${formatGamificationPoints(feedback.points)}`.trim();
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
  const spawnSlotCount = maxVisible * 2 + 1;
  const spawnColumns = Math.ceil(Math.sqrt(spawnSlotCount));
  const spawnRows = Math.ceil(spawnSlotCount / spawnColumns);
  let nextSpawnSlot = Math.floor(spawnColumns / 2);
  let previousSpawnSlot: number | null = null;
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
    if (feedback.kind !== "typing") receipt.textContent = gamificationFeedbackLabel(feedback);
    if (reduced() && feedback.kind === "typing") return;
    const item = document.createElement("div");
    item.className = "um-game-feedback";
    item.dataset.kind = feedback.kind ?? "score";
    item.dataset.motion = reduced() ? "reduced" : "full";
    item.dataset.magnitude =
      typeof feedback.points === "number" && Math.abs(feedback.points) <= 10 ? "small" : "large";
    item.style.color = getGamificationFeedbackColor(feedback.points, feedback.kind);
    while (layer.childElementCount >= maxVisible) layer.firstElementChild?.remove();
    // Reserve origins until their popup disappears; randomness alone can cluster rewards.
    const occupied = new Set(
      Array.from(layer.children, (child) => child.getAttribute("data-spawn-slot")),
    );
    let slot = nextSpawnSlot;
    let bestDistance = -1;
    for (let offset = 0; offset < spawnSlotCount; offset++) {
      const candidate = (nextSpawnSlot + offset) % spawnSlotCount;
      if (occupied.has(String(candidate))) continue;
      const dx =
        previousSpawnSlot === null
          ? 0
          : ((candidate % spawnColumns) - (previousSpawnSlot % spawnColumns)) /
            Math.max(1, spawnColumns - 1);
      const dy =
        previousSpawnSlot === null
          ? 0
          : (Math.floor(candidate / spawnColumns) - Math.floor(previousSpawnSlot / spawnColumns)) /
            Math.max(1, spawnRows - 1);
      const distance = dx * dx + dy * dy;
      if (distance > bestDistance) {
        slot = candidate;
        bestDistance = distance;
      }
    }
    previousSpawnSlot = slot;
    nextSpawnSlot = (slot + 1) % spawnSlotCount;
    item.dataset.spawnSlot = String(slot);
    const column = slot % spawnColumns;
    const row = Math.floor(slot / spawnColumns);
    const spacing = 60 / Math.max(1, spawnColumns - 1);
    item.style.left = `${50 + (column - (spawnColumns - 1) / 2) * spacing + Math.random() * 4 - 2}%`;
    item.style.top = `${-(reduced() ? 30 : 8) - (row * 54) / Math.max(1, spawnRows - 1) + Math.random() * 4 - 2}px`;
    item.style.setProperty("--um-game-rotation", `${Math.random() * 24 - 12}deg`);
    item.style.setProperty("--um-game-lifetime", `${lifetime}ms`);
    const symbol = document.createElement("span");
    symbol.className = "um-game-feedback-symbol";
    if (feedback.kind === "model_accept") symbol.appendChild(createModelIcon(document));
    else symbol.textContent = gamificationFeedbackSymbol(feedback);
    const value = document.createElement("span");
    value.className = "um-game-feedback-points";
    value.textContent = formatGamificationPoints(feedback.points);
    item.append(symbol, value);
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
    nextSpawnSlot = Math.floor(spawnColumns / 2);
    previousSpawnSlot = null;
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
