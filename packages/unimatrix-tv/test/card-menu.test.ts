import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCardMenu, type CardMenu } from "../src/card-menu.js";

let menu: CardMenu;
const popup = () => document.querySelector<HTMLElement>(".utv-card-menu")!;
const items = () => [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
const key = (value: string) =>
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: value, bubbles: true }),
  );
const trigger = () => {
  const button = document.createElement("button");
  document.body.append(button);
  return button;
};
const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON() {},
});
const spec = () => ({
  label: "Movie actions",
  actions: [
    { label: "Watchlist", run: vi.fn() },
    { label: "Unavailable", disabled: true, run: vi.fn() },
    { label: "Go to Movie", run: vi.fn() },
  ],
});

beforeEach(() => {
  document.body.replaceChildren();
  menu = createCardMenu();
});
afterEach(() => {
  menu.dispose();
  vi.restoreAllMocks();
});

describe("card overflow menu", () => {
  it("clamps placement to the viewport and flips above a low trigger", () => {
    vi.spyOn(popup(), "getBoundingClientRect").mockReturnValue(rect(0, 0, 240, 160));
    const button = trigger();
    const bounds = vi
      .spyOn(button, "getBoundingClientRect")
      .mockReturnValue(rect(0, window.innerHeight - 32, 24, 24));
    menu.open(button, spec());
    expect(popup().dataset.placement).toBe("above");
    expect(popup().style.left).toBe("8px");
    expect(parseFloat(popup().style.top)).toBe(window.innerHeight - 200);
    bounds.mockReturnValue(rect(window.innerWidth + 50, 0, 24, 24));
    window.dispatchEvent(new Event("resize"));
    expect(popup().dataset.placement).toBe("below");
    expect(parseFloat(popup().style.left)).toBe(window.innerWidth - 248);
    expect(parseFloat(popup().style.top)).toBe(32);
  });

  it("moves keyboard focus around enabled items and restores it on Escape", () => {
    const button = trigger();
    menu.open(button, spec());
    expect(document.activeElement).toBe(items()[0]);
    expect(button.getAttribute("aria-controls")).toBe(popup().id);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    key("ArrowUp");
    expect(document.activeElement).toBe(items()[2]);
    key("ArrowDown");
    expect(document.activeElement).toBe(items()[0]);
    key("End");
    expect(document.activeElement).toBe(items()[2]);
    key("Home");
    expect(document.activeElement).toBe(items()[0]);
    key("Escape");
    expect(popup().hidden).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("dismisses outside without stealing focus and allows Tab to leave", () => {
    const button = trigger();
    const outside = trigger();
    menu.open(button, spec());
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    outside.focus();
    expect(popup().hidden).toBe(true);
    expect(document.activeElement).toBe(outside);
    menu.open(button, spec());
    outside.focus();
    expect(popup().hidden).toBe(true);
  });

  it("reuses the popup when switching triggers and toggles the active trigger", () => {
    const first = trigger();
    const second = trigger();
    first.setAttribute("aria-controls", "original");
    menu.open(first, spec());
    menu.open(second, spec());
    expect(document.querySelectorAll(".utv-card-menu")).toHaveLength(1);
    expect(first.getAttribute("aria-controls")).toBe("original");
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(second.getAttribute("aria-expanded")).toBe("true");
    menu.open(second, spec());
    expect(popup().hidden).toBe(true);
    expect(document.activeElement).toBe(second);
  });

  it("catches rejected actions, permits retry, and closes after success", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret upstream text"))
      .mockResolvedValueOnce(undefined);
    const button = trigger();
    menu.open(button, { label: "Actions", actions: [{ label: "Save", run }] });
    items()[0]!.click();
    await vi.waitFor(() => {
      expect(popup().querySelector("[role=alert]")?.textContent).toContain("Try again");
    });
    expect(popup().textContent).not.toContain("secret");
    expect(items()[0]!.disabled).toBe(false);
    items()[0]!.click();
    await vi.waitFor(() => {
      expect(popup().hidden).toBe(true);
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(button);
  });

  it("prevents recycled-card callbacks and ignores old async failures", async () => {
    let current = true;
    const run = vi.fn();
    menu.open(trigger(), {
      label: "Actions",
      actions: [{ label: "Save", run }],
      valid: () => current,
    });
    current = false;
    items()[0]!.click();
    expect(run).not.toHaveBeenCalled();
    expect(popup().hidden).toBe(true);
    let reject: (error: Error) => void = () => {};
    menu.open(trigger(), {
      label: "Pending",
      actions: [
        {
          label: "Save",
          run: () =>
            new Promise<void>((_resolve, failure) => {
              reject = failure;
            }),
        },
      ],
    });
    items()[0]!.click();
    menu.open(trigger(), spec());
    reject(new Error("Old failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(popup().getAttribute("aria-label")).toBe("Movie actions");
    expect(popup().querySelector("[role=alert]")).toBeNull();
  });

  it("ignores old menu buttons retained after switching cards", () => {
    const first = spec();
    menu.open(trigger(), first);
    const oldAction = items()[0]!;
    menu.open(trigger(), spec());
    oldAction.click();
    expect(first.actions[0]!.run).not.toHaveBeenCalled();
  });

  it("uses native top-layer popovers where available", () => {
    const show = vi.fn();
    const hide = vi.fn();
    popup().showPopover = show;
    popup().hidePopover = hide;
    menu.open(trigger(), spec());
    expect(show).toHaveBeenCalledOnce();
    menu.close();
    expect(hide).toHaveBeenCalledOnce();
  });

  it("falls back when native popovers fail and remains dismissible while an action is pending", () => {
    popup().showPopover = () => {
      throw new Error("Unavailable");
    };
    menu.open(trigger(), {
      label: "Pending",
      actions: [{ label: "Save", run: () => new Promise<void>(() => {}) }],
    });
    expect(popup().hasAttribute("popover")).toBe(false);
    items()[0]!.click();
    expect(popup().getAttribute("aria-busy")).toBe("true");
    key("Escape");
    expect(popup().hidden).toBe(true);
    expect(popup().hasAttribute("aria-busy")).toBe(false);
  });

  it("closes after an account becomes stale during a failed action", async () => {
    let current = true;
    let reject: (error: Error) => void = () => {};
    menu.open(trigger(), {
      label: "Save",
      valid: () => current,
      actions: [
        {
          label: "Save",
          run: () =>
            new Promise<void>((_resolve, failure) => {
              reject = failure;
            }),
        },
      ],
    });
    items()[0]!.click();
    current = false;
    reject(new Error("Rejected"));
    await Promise.resolve();
    await Promise.resolve();
    expect(popup().hidden).toBe(true);
    expect(popup().querySelector("[role=alert]")).toBeNull();
  });

  it("contains synchronous callback and validity failures", async () => {
    menu.open(trigger(), {
      label: "Save",
      actions: [
        {
          label: "Save",
          run: () => {
            throw new Error("Failed");
          },
        },
      ],
    });
    items()[0]!.click();
    await vi.waitFor(() => {
      expect(popup().querySelector("[role=alert]")).not.toBeNull();
    });
    const run = vi.fn();
    menu.open(trigger(), {
      label: "Stale",
      valid: () => {
        throw new Error("Account unavailable");
      },
      actions: [{ label: "Save", run }],
    });
    expect(popup().hidden).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("inserts labels as text and removes listeners and markup on disposal", () => {
    const button = trigger();
    menu.open(button, {
      label: "Actions",
      actions: [{ label: "<img src=x onerror=alert(1)>", run: vi.fn() }],
    });
    expect(popup().querySelector("img")).toBeNull();
    menu.dispose();
    expect(document.querySelector(".utv-card-menu")).toBeNull();
    expect(document.activeElement).toBe(button);
    menu.open(button, spec());
    window.dispatchEvent(new Event("resize"));
    expect(document.querySelector(".utv-card-menu")).toBeNull();
  });
});
