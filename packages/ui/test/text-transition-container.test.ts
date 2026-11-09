import { afterEach, describe, expect, it, vi } from "vitest";
import { createTextTransition } from "../src/public.js";

function fixture() {
  const panel = document.createElement("section");
  const label = document.createElement("span");
  label.textContent = "Original";
  panel.appendChild(label);
  document.body.appendChild(panel);
  const animations: {
    frames: Keyframe[];
    options: KeyframeAnimationOptions;
    finish: () => void;
    cancel: ReturnType<typeof vi.fn>;
  }[] = [];
  Object.defineProperty(panel, "animate", {
    configurable: true,
    value: vi.fn((frames: Keyframe[], options: KeyframeAnimationOptions) => {
      let finish = (): void => {};
      let reject = (): void => {};
      const finished = new Promise<void>((resolve, deny) => {
        finish = resolve;
        reject = () => {
          deny(new Error("cancelled"));
        };
      });
      const cancel = vi.fn(reject);
      animations.push({ frames, options, finish, cancel });
      return { finished, cancel } as unknown as Animation;
    }),
  });
  return { panel, label, animations };
}
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("container text transitions", () => {
  it("retains outgoing contents until hidden and enters only the latest queued label", async () => {
    const { panel, label, animations } = fixture();
    const transition = createTextTransition(label, {
      mode: "container",
      container: panel,
      durationMs: 300,
    });
    expect(panel.style.visibility).toBe("hidden");
    transition.update("First");
    expect(label.textContent).toBe("First");
    expect(animations[0]?.options.duration).toBe(300);
    animations[0]?.finish();
    await flush();
    transition.pending();
    transition.pending();
    expect(label.textContent).toBe("First");
    expect(panel).toHaveAttribute("aria-hidden", "true");
    expect(animations).toHaveLength(2);
    expect(animations[1]?.options.duration).toBe(150);
    transition.update("Intermediate");
    transition.update("Latest");
    expect(label.textContent).toBe("First");
    expect(animations).toHaveLength(2);
    animations[1]?.finish();
    await flush();
    expect(label.textContent).toBe("Latest");
    expect(panel.style.visibility).toBe("visible");
    expect(panel).not.toHaveAttribute("aria-hidden");
    expect(animations).toHaveLength(3);
    animations[2]?.finish();
    await flush();
    const settledCount = animations.length;
    transition.update("Latest");
    expect(animations).toHaveLength(settledCount);
    transition.dispose();
  });

  it("hides the complete panel for blank text and never animates label width", async () => {
    const { panel, label, animations } = fixture();
    const transition = createTextTransition(label, { mode: "container", container: panel });
    transition.update("Long label ".repeat(20));
    animations[0]?.finish();
    await flush();
    transition.update("");
    expect(label.textContent).toContain("Long label");
    animations[1]?.finish();
    await flush();
    expect(label.textContent).toBe("");
    expect(panel.style.visibility).toBe("hidden");
    expect(panel.style.opacity).toBe("0");
    transition.update("Short");
    expect(panel.style.visibility).toBe("visible");
    expect(label.textContent).toBe("Short");
    for (const animation of animations)
      for (const frame of animation.frames) {
        expect(frame).not.toHaveProperty("width");
        expect(frame).not.toHaveProperty("height");
      }
    transition.dispose();
  });

  it("cancels interrupted entrances and disposal blocks queued stale content", async () => {
    const { panel, label, animations } = fixture();
    panel.style.setProperty("opacity", ".7", "important");
    panel.style.pointerEvents = "none";
    panel.setAttribute("aria-hidden", "false");
    label.dataset.textTransition = "caller";
    const transition = createTextTransition(label, { mode: "container", container: panel });
    transition.update("Visible");
    transition.pending();
    expect(animations[0]?.cancel).toHaveBeenCalledOnce();
    transition.update("Must not appear");
    transition.dispose();
    animations[1]?.finish();
    await flush();
    expect(label.textContent).toBe("Visible");
    expect(panel.style.opacity).toBe("0.7");
    expect(panel.style.getPropertyPriority("opacity")).toBe("important");
    expect(panel.style.pointerEvents).toBe("none");
    expect(panel).toHaveAttribute("aria-hidden", "false");
    expect(label.dataset.textTransition).toBe("caller");
    transition.update("Ignored");
    transition.pending();
    expect(label.textContent).toBe("Visible");
  });

  it("settles reduced motion and immediate updates without an animation", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const { panel, label, animations } = fixture();
    const transition = createTextTransition(label, { mode: "container", container: panel });
    transition.update("Reduced");
    transition.pending();
    transition.update("");
    expect(animations).toHaveLength(0);
    expect(panel.style.visibility).toBe("hidden");
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    transition.update("Immediate", { immediate: true });
    expect(label.textContent).toBe("Immediate");
    expect(panel.style.visibility).toBe("visible");
    expect(animations).toHaveLength(0);
    transition.dispose();
  });
});
