import { afterEach, describe, expect, it, vi } from "vitest";
import { createTextTransition } from "../src/public.js";

function node(text = "Old"): HTMLSpanElement {
  const element = document.createElement("span");
  element.textContent = text;
  document.body.appendChild(element);
  return element;
}
function motion(element: HTMLElement) {
  const created: {
    cancel: ReturnType<typeof vi.fn>;
    finish: () => void;
    reject: () => void;
    frames: Keyframe[];
  }[] = [];
  const animate = vi.fn((frames: Keyframe[]) => {
    let finish = (): void => {};
    let reject = (): void => {};
    const finished = new Promise<void>((resolve, deny) => {
      finish = resolve;
      reject = () => {
        deny(new Error("cancelled"));
      };
    });
    const entry = { cancel: vi.fn(), finish, reject, frames };
    created.push(entry);
    return { finished, cancel: entry.cancel } as unknown as Animation;
  });
  Object.defineProperty(element, "animate", { value: animate, configurable: true });
  return { animate, created };
}
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("createTextTransition", () => {
  it("hides stale text immediately without replacing its layout content and pending is idempotent", () => {
    const element = node();
    const { animate } = motion(element);
    const transition = createTextTransition(element);
    transition.pending();
    transition.pending();
    expect(element.textContent).toBe("Old");
    expect(element.style.opacity).toBe("0");
    expect(element).toHaveAttribute("aria-hidden", "true");
    expect(animate).not.toHaveBeenCalled();
    transition.update("New");
    expect(element.textContent).toBe("New");
    expect(element).not.toHaveAttribute("aria-hidden");
    expect(element.style.opacity).toBe("");
    expect(animate).toHaveBeenCalledOnce();
    transition.dispose();
  });

  it("cancels rapid older updates and stale finishes cannot change current state", async () => {
    const element = node();
    const { created } = motion(element);
    const transition = createTextTransition(element);
    transition.update("First");
    transition.pending();
    transition.update("Latest");
    expect(created[0]?.cancel).toHaveBeenCalledOnce();
    created[0]?.finish();
    await flush();
    expect(element.textContent).toBe("Latest");
    expect(element.dataset.textTransition).toBe("entering");
    created[1]?.finish();
    await flush();
    expect(element.dataset.textTransition).toBe("settled");
    expect(created[1]?.cancel).toHaveBeenCalledOnce();
    transition.dispose();
  });

  it("does not replay identical settled text but enters the same text after pending", async () => {
    const element = node();
    const { animate, created } = motion(element);
    const transition = createTextTransition(element);
    transition.update("Old");
    expect(animate).not.toHaveBeenCalled();
    transition.pending();
    transition.update("Old");
    expect(animate).toHaveBeenCalledOnce();
    created[0]?.finish();
    await flush();
    transition.update("Old");
    expect(animate).toHaveBeenCalledOnce();
    transition.dispose();
  });

  it("uses immediate reduced-motion and no-WAAPI paths without timers", () => {
    const element = node();
    const { animate } = motion(element);
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const transition = createTextTransition(element);
    transition.pending();
    transition.update("Reduced");
    expect(animate).not.toHaveBeenCalled();
    expect(element).not.toHaveAttribute("aria-hidden");
    expect(element.dataset.textTransition).toBe("settled");
    transition.dispose();
    const plain = node();
    const fallback = createTextTransition(plain);
    fallback.pending();
    fallback.update("No API");
    expect(plain.textContent).toBe("No API");
    expect(plain.style.opacity).toBe("");
    fallback.dispose();
  });

  it("only shrinks through widths that fit the final label, leaving no sizing styles", async () => {
    const element = node();
    const container = document.createElement("div");
    container.appendChild(element);
    const elementMotion = motion(element);
    const containerMotion = motion(container);
    vi.spyOn(container, "getBoundingClientRect")
      .mockReturnValueOnce({ width: 640, height: 20 } as DOMRect)
      .mockReturnValueOnce({ width: 20, height: 20 } as DOMRect);
    const transition = createTextTransition(element, { container });
    transition.update("A");
    expect(containerMotion.created[0]?.frames).toEqual([{ width: "640px" }, { width: "20px" }]);
    elementMotion.created[0]?.finish();
    containerMotion.created[0]?.finish();
    await flush();
    expect(container.style.width).toBe("");
    expect(container.style.height).toBe("");
    vi.spyOn(container, "getBoundingClientRect")
      .mockReturnValueOnce({ width: 140, height: 20 } as DOMRect)
      .mockReturnValueOnce({ width: 140, height: 40 } as DOMRect);
    transition.update("Wrapped label");
    expect(containerMotion.animate).toHaveBeenCalledOnce();
    transition.dispose();
  });

  it("never lays out a long incoming label at an intermediate narrow width", () => {
    const element = node("A");
    const container = document.createElement("div");
    container.appendChild(element);
    const textMotion = motion(element);
    const widthMotion = motion(container);
    vi.spyOn(container, "getBoundingClientRect")
      .mockReturnValueOnce({ width: 20, height: 20 } as DOMRect)
      .mockReturnValueOnce({ width: 640, height: 20 } as DOMRect);
    const transition = createTextTransition(element, { container });
    const long = "A".repeat(80);
    transition.pending();
    transition.update(long);
    expect(element.textContent).toBe(long);
    expect(textMotion.animate).toHaveBeenCalledOnce();
    expect(widthMotion.animate).not.toHaveBeenCalled();
    expect(element.style.width).toBe("");
    expect(element.style.minWidth).toBe("");
    expect(container.style.width).toBe("");
    expect(container.style.overflow).toBe("");
    transition.dispose();
  });

  it("keeps long wrapped labels readable in narrow layouts and cancels a shrink before a rapid long update", async () => {
    const element = node("A".repeat(80));
    const container = document.createElement("div");
    container.appendChild(element);
    const textMotion = motion(element);
    const widthMotion = motion(container);
    const measurements = vi.spyOn(container, "getBoundingClientRect");
    measurements
      .mockReturnValueOnce({ width: 640, height: 20 } as DOMRect)
      .mockReturnValueOnce({ width: 20, height: 20 } as DOMRect)
      .mockReturnValueOnce({ width: 20, height: 20 } as DOMRect)
      .mockReturnValueOnce({ width: 220, height: 60 } as DOMRect);
    const transition = createTextTransition(element, { container });
    transition.update("A");
    const shortAnimation = textMotion.created[0];
    const shrink = widthMotion.created[0];
    transition.pending();
    transition.update("B".repeat(80));
    expect(shortAnimation?.cancel).toHaveBeenCalledOnce();
    expect(shrink?.cancel).toHaveBeenCalledOnce();
    expect(widthMotion.animate).toHaveBeenCalledOnce();
    expect(element.textContent).toHaveLength(80);
    shortAnimation?.finish();
    shrink?.finish();
    await flush();
    expect(element.dataset.textTransition).toBe("entering");
    expect(element.style.height).toBe("");
    expect(element.style.maxWidth).toBe("");
    transition.dispose();
  });

  it("settles the latest text on viewport resize and removes its listener on disposal", async () => {
    const element = node("A".repeat(80));
    const container = document.createElement("div");
    container.appendChild(element);
    const textMotion = motion(element);
    const widthMotion = motion(container);
    vi.spyOn(container, "getBoundingClientRect")
      .mockReturnValueOnce({ width: 640, height: 20 } as DOMRect)
      .mockReturnValueOnce({ width: 20, height: 20 } as DOMRect);
    const transition = createTextTransition(element, { container });
    transition.update("A");
    window.dispatchEvent(new Event("resize"));
    expect(textMotion.created[0]?.cancel).toHaveBeenCalledOnce();
    expect(widthMotion.created[0]?.cancel).toHaveBeenCalledOnce();
    expect(element.dataset.textTransition).toBe("settled");
    expect(element.textContent).toBe("A");
    expect(container.style.width).toBe("");
    expect(container.style.height).toBe("");
    textMotion.created[0]?.finish();
    widthMotion.created[0]?.finish();
    await flush();
    transition.pending();
    window.dispatchEvent(new Event("resize"));
    expect(element).toHaveAttribute("aria-hidden", "true");
    const removal = vi.spyOn(window, "removeEventListener");
    transition.dispose();
    expect(removal).toHaveBeenCalledWith("resize", expect.any(Function));
  });

  it("disposes cancellations and restores caller visibility/ARIA, accepting immediate error text", async () => {
    const element = node();
    element.style.opacity = ".8";
    element.setAttribute("aria-hidden", "false");
    element.dataset.textTransition = "caller";
    const { created, animate } = motion(element);
    const transition = createTextTransition(element);
    transition.update("New");
    transition.update("—", { immediate: true });
    expect(created[0]?.cancel).toHaveBeenCalledOnce();
    expect(element.textContent).toBe("—");
    expect(animate).toHaveBeenCalledOnce();
    transition.pending();
    transition.dispose();
    expect(element.style.opacity).toBe("0.8");
    expect(element).toHaveAttribute("aria-hidden", "false");
    expect(element.dataset.textTransition).toBe("caller");
    expect(element).not.toHaveClass("um-text-transition");
    created[0]?.reject();
    await flush();
    transition.update("Ignored");
    transition.pending();
    expect(element.textContent).toBe("—");
    expect(element.dataset.textTransition).toBe("caller");
  });
});
