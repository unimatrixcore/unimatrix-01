import { createRef } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGamificationEffects,
  createModelIcon,
  ModelIcon,
  GamificationEffectsLayer,
  getGamificationFeedbackColor,
  ScoreFeedback,
} from "../src/public.js";
import type { GamificationEffects } from "../src/public.js";

function host(): HTMLDivElement {
  const node = document.createElement("div");
  document.body.appendChild(node);
  return node;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("gamification feedback", () => {
  it("bounds bursts, safely renders glyphs, and expires them", () => {
    vi.useFakeTimers();
    const node = host();
    const controller = createGamificationEffects(node, {
      maxVisible: 2,
      maxQueued: 3,
      staggerMs: 1,
      lifetimeMs: 100,
    });
    controller.emit({ points: 5, kind: "typing", glyph: "<img onerror=bad>" });
    expect(node.querySelector("img")).toBeNull();
    expect(node.textContent).toContain("<img onerror=bad>");
    for (let i = 0; i < 100; i++) controller.emit({ points: i + 1, kind: "quick" });
    vi.advanceTimersByTime(5);
    expect(node.querySelectorAll(".um-game-feedback")).toHaveLength(2);
    expect(node.querySelector('[role="status"]')).toHaveTextContent("+100");
    vi.advanceTimersByTime(110);
    expect(node.querySelectorAll(".um-game-feedback")).toHaveLength(0);
    controller.dispose();
  });

  it.each([false, true])(
    "separates active popup origins even with identical random draws (reduced=%s)",
    (reducedMotion) => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const node = host();
      const controller = createGamificationEffects(node, {
        maxVisible: 3,
        maxQueued: 16,
        staggerMs: 1,
        lifetimeMs: 100,
        reducedMotion,
      });
      for (let index = 0; index < 12; index++) controller.emit({ points: 100, kind: "quick" });
      for (let index = 0; index < 12; index++) {
        vi.advanceTimersByTime(1);
        const items = Array.from(node.querySelectorAll<HTMLElement>(".um-game-feedback"));
        expect(items.length).toBeLessThanOrEqual(3);
        expect(new Set(items.map((item) => `${item.style.left}:${item.style.top}`)).size).toBe(
          items.length,
        );
        expect(new Set(items.map((item) => item.dataset.spawnSlot)).size).toBe(items.length);
      }
      vi.advanceTimersByTime(101);
      expect(node.querySelectorAll(".um-game-feedback")).toHaveLength(0);
      controller.clear();
      controller.emit({ points: 100, kind: "quick" });
      expect(node.querySelectorAll(".um-game-feedback")).toHaveLength(1);
      controller.dispose();
    },
  );

  it("spreads consecutive rewards across a wider area instead of adjacent slots", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const node = host();
    const controller = createGamificationEffects(node, { staggerMs: 1 });
    let previous: { x: number; y: number } | null = null;
    for (let index = 0; index < 12; index++) {
      controller.emit({ points: 100, kind: "quick" });
      vi.advanceTimersByTime(1);
      const item = node.querySelector<HTMLElement>(".um-game-feedback:last-child")!;
      const position = { x: parseFloat(item.style.left), y: parseFloat(item.style.top) };
      expect(position.x).toBeGreaterThanOrEqual(18);
      expect(position.x).toBeLessThanOrEqual(82);
      if (previous)
        expect(
          Math.abs(position.x - previous.x) >= 20 || Math.abs(position.y - previous.y) >= 20,
        ).toBe(true);
      previous = position;
    }
    controller.dispose();
  });

  it("clear cancels pending bursts; disposal cannot resurrect a context", () => {
    vi.useFakeTimers();
    const node = host();
    const controller = createGamificationEffects(node);
    controller.emit({ points: 10 });
    controller.emit({ points: 20 });
    controller.clear();
    vi.runAllTimers();
    expect(node.querySelectorAll(".um-game-feedback")).toHaveLength(0);
    controller.emit({ points: 30 });
    expect(node.querySelectorAll(".um-game-feedback")).toHaveLength(1);
    controller.dispose();
    controller.emit({ points: 40 });
    vi.runAllTimers();
    expect(node).toBeEmptyDOMElement();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors reduced motion dynamically and retains accessible completion feedback", () => {
    vi.useFakeTimers();
    let reduced = true;
    const node = host();
    const controller = createGamificationEffects(node, {
      reducedMotion: () => reduced,
      staggerMs: 1,
    });
    controller.emit({ points: 5, kind: "typing", glyph: "A" });
    expect(node.querySelector(".um-game-feedback")).toBeNull();
    controller.emit({ points: 60, kind: "auto", multiplier: 5 });
    vi.advanceTimersByTime(1);
    expect(node.querySelector(".um-game-feedback")).toHaveAttribute("data-motion", "reduced");
    expect(node.querySelector('[role="status"]')).toHaveTextContent("+60");
    expect(node.querySelector(".um-game-effects")).not.toHaveClass("um-game-burst");
    reduced = false;
    controller.emit({ points: 500, kind: "quick", multiplier: 5 });
    vi.advanceTimersByTime(1);
    expect(node.querySelector(".um-game-effects")).toHaveClass("um-game-burst");
    controller.dispose();
  });

  it("keeps feedback kinds distinct when points and multipliers coincide", () => {
    const kinds = [
      "typing",
      "tab",
      "quick",
      "auto",
      "model_accept",
      "correction",
      "name_bonus",
      "delete",
      "discard",
      "penalty",
    ] as const;
    const colors = kinds.map((kind) => getGamificationFeedbackColor(100, kind));
    expect(new Set(colors).size).toBe(kinds.length);
    for (const kind of kinds) {
      expect(getGamificationFeedbackColor(5, kind)).toBe(getGamificationFeedbackColor(500, kind));
    }
    vi.useFakeTimers();
    const node = host();
    const controller = createGamificationEffects(node, { staggerMs: 1 });
    controller.emit({ points: 100, kind: "auto" });
    expect(node.querySelector<HTMLElement>("[data-kind=auto]")?.style.color).toBe(
      getGamificationFeedbackColor(100, "auto"),
    );
    controller.dispose();
    const { container } = render(<ScoreFeedback points={100} kind="auto" />);
    expect(container.querySelector<HTMLElement>("[data-kind=auto]")?.style.color).toBe(
      getGamificationFeedbackColor(100, "auto"),
    );
  });

  it("renders model acceptance as the shared robot in native feedback and keeps auto/quick separate", () => {
    vi.useFakeTimers();
    const node = host();
    const controller = createGamificationEffects(node, { staggerMs: 1, reducedMotion: true });
    controller.emit({ points: 100, kind: "model_accept", multiplier: 5 });
    controller.emit({ points: 100, kind: "auto", multiplier: 5 });
    controller.emit({ points: 100, kind: "quick", multiplier: 5 });
    const accepted = node.querySelector<HTMLElement>("[data-kind=model_accept]")!;
    expect(accepted.style.color).toBe(getGamificationFeedbackColor(100, "model_accept"));
    expect(accepted).toHaveAttribute("data-motion", "reduced");
    const robot = accepted.querySelector("svg")!;
    expect(robot.isEqualNode(createModelIcon(document))).toBe(true);
    expect(robot).toHaveAttribute("aria-hidden", "true");
    expect(robot).toHaveAttribute("viewBox", "0 0 24 24");
    expect(robot.querySelectorAll("path")).toHaveLength(2);
    expect(robot.querySelector("rect")).toHaveAttribute("rx", "2");
    expect(node.querySelector('[role="status"]')).toHaveTextContent("Model accepted +100");
    expect(node.querySelector(".um-game-effects")).not.toHaveClass("um-game-burst");
    vi.advanceTimersByTime(2);
    expect(node.querySelector("[data-kind=auto] .um-game-feedback-symbol")).toHaveTextContent("◷");
    expect(node.querySelector("[data-kind=quick] .um-game-feedback-symbol")).toHaveTextContent("ϟ");
    expect(node.querySelector("[data-kind=auto] svg")).toBeNull();
    expect(node.querySelector("[data-kind=quick] svg")).toBeNull();
    controller.dispose();
  });

  it("uses one robot definition for React, native model labels and accepted-score feedback", () => {
    const { container } = render(<ModelIcon className="model-output-icon" />);
    expect(
      container.querySelector("svg")!.isEqualNode(createModelIcon(document, "model-output-icon")),
    ).toBe(true);
    render(
      <ScoreFeedback points={100} kind="model_accept" glyph="<img onerror=bad>" reducedMotion />,
    );
    const accepted = screen.getByRole("img", { name: "Model accepted +100" });
    expect(accepted).toHaveAttribute("data-kind", "model_accept");
    expect(accepted).toHaveAttribute("data-motion", "reduced");
    expect(accepted).toHaveTextContent("+100");
    expect(accepted.querySelector("svg")!.isEqualNode(createModelIcon(document))).toBe(true);
    expect(accepted.querySelector("img")).toBeNull();
    expect(accepted.style.color).toBe(getGamificationFeedbackColor(100, "model_accept"));
    expect(getGamificationFeedbackColor(100, "model_accept")).not.toBe(
      getGamificationFeedbackColor(100, "auto"),
    );
    expect(getGamificationFeedbackColor(100, "model_accept")).not.toBe(
      getGamificationFeedbackColor(100, "quick"),
    );
  });

  it("uses shared theme tokens and rejects non-finite scores", () => {
    vi.useFakeTimers();
    expect(getGamificationFeedbackColor(-5)).toBe("var(--destructive)");
    expect(getGamificationFeedbackColor(5)).toBe("var(--muted-foreground)");
    expect(getGamificationFeedbackColor(20)).toBe("var(--foreground)");
    expect(getGamificationFeedbackColor(100)).toBe("var(--primary)");
    expect(getGamificationFeedbackColor(200)).toBe("var(--chart-3)");
    expect(getGamificationFeedbackColor(500)).toBe("var(--chart-2)");
    const node = host();
    const controller = createGamificationEffects(node);
    controller.emit({ points: Number.NaN });
    controller.emit({ points: Number.POSITIVE_INFINITY });
    expect(node.querySelector(".um-game-feedback")).toBeNull();
    controller.dispose();
  });

  it("supports a React layer ref and disposes when unmounted", () => {
    vi.useFakeTimers();
    const ref = createRef<GamificationEffects>();
    const { container, unmount } = render(<GamificationEffectsLayer ref={ref} />);
    act(() => ref.current?.emit({ points: 100, kind: "quick" }));
    expect(container.querySelector(".um-game-feedback")).toHaveTextContent("+100");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("offers declarative feedback with escaped content and an accessible label", () => {
    render(<ScoreFeedback points={5} kind="typing" glyph="<" reducedMotion />);
    expect(screen.getByRole("img", { name: "< +5" })).toHaveAttribute("data-motion", "reduced");
    expect(screen.getByRole("img", { name: "< +5" })).toHaveTextContent("<+5");
  });
});
