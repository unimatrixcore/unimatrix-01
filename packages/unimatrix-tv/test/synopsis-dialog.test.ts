import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSynopsisDialog, type SynopsisDialog } from "../src/synopsis-dialog.js";

let synopsis: SynopsisDialog;
const modal = () => document.querySelector<HTMLDialogElement>(".utv-synopsis-dialog")!;
const closeButton = () => modal().querySelector<HTMLButtonElement>("button")!;
const trigger = () => {
  const button = document.createElement("button");
  document.body.append(button);
  return button;
};
const spec = { title: "Westworld", text: "A complete, unabridged synopsis." };
const key = (value: string, shiftKey = false) =>
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }),
  );

beforeEach(() => {
  document.body.replaceChildren();
  document.body.style.overflow = "auto";
  synopsis = createSynopsisDialog();
});
afterEach(() => {
  synopsis.dispose();
  vi.restoreAllMocks();
});

describe("synopsis dialog", () => {
  it("uses a labelled modal with safe title and synopsis text", () => {
    synopsis.open(trigger(), { title: "<img src=x>", text: "<script>bad()</script>" });
    expect(modal().hidden).toBe(false);
    expect(modal().getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(modal().getAttribute("aria-labelledby")!)?.textContent).toBe(
      "<img src=x>",
    );
    expect(document.getElementById(modal().getAttribute("aria-describedby")!)?.textContent).toBe(
      "<script>bad()</script>",
    );
    expect(modal().querySelector("img,script")).toBeNull();
    expect(document.activeElement).toBe(closeButton());
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("closes with the X, restores focus and restores background scrolling", () => {
    const button = trigger();
    synopsis.open(button, spec);
    closeButton().click();
    expect(modal().hidden).toBe(true);
    expect(modal().hasAttribute("open")).toBe(false);
    expect(modal().querySelector("p")?.textContent).toBe("");
    expect(document.activeElement).toBe(button);
    expect(document.body.style.overflow).toBe("auto");
    synopsis.close();
  });

  it("dismisses on Escape and native cancel, but not a content click", () => {
    const button = trigger();
    synopsis.open(button, spec);
    modal().querySelector("p")!.click();
    expect(modal().hidden).toBe(false);
    key("Escape");
    expect(modal().hidden).toBe(true);
    expect(document.activeElement).toBe(button);
    synopsis.open(button, spec);
    const cancel = new Event("cancel", { cancelable: true });
    modal().dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(modal().hidden).toBe(true);
  });

  it("closes on the backdrop and reuses one dialog for another title", () => {
    const first = trigger();
    const second = trigger();
    synopsis.open(first, spec);
    synopsis.open(second, { title: "Another title", text: "Other text" });
    expect(document.querySelectorAll(".utv-synopsis-dialog")).toHaveLength(1);
    expect(modal().querySelector("h2")?.textContent).toBe("Another title");
    modal().click();
    expect(modal().hidden).toBe(true);
    expect(document.activeElement).toBe(second);
    expect(document.body.style.overflow).toBe("auto");
  });

  it("contains fallback focus, including forward and backward Tab", () => {
    synopsis.open(trigger(), spec);
    expect(modal().classList.contains("utv-synopsis-fallback")).toBe(true);
    key("Tab");
    expect(document.activeElement).toBe(closeButton());
    key("Tab", true);
    expect(document.activeElement).toBe(closeButton());
    trigger().focus();
    expect(document.activeElement).toBe(closeButton());
  });

  it("uses native modal behavior when supported and responds to native close", () => {
    const show = vi.fn(() => {
      modal().setAttribute("open", "");
    });
    modal().showModal = show;
    const hide = vi.fn(() => {
      modal().removeAttribute("open");
      modal().dispatchEvent(new Event("close"));
    });
    modal().close = hide;
    const button = trigger();
    synopsis.open(button, spec);
    expect(show).toHaveBeenCalledOnce();
    expect(modal().classList.contains("utv-synopsis-fallback")).toBe(false);
    synopsis.open(button, spec);
    expect(show).toHaveBeenCalledOnce();
    synopsis.close();
    expect(hide).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(button);
    synopsis.open(button, spec);
    modal().removeAttribute("open");
    modal().dispatchEvent(new Event("close"));
    expect(modal().hidden).toBe(true);
  });

  it("ignores a queued close event from an earlier opening", () => {
    modal().showModal = () => {
      modal().setAttribute("open", "");
    };
    modal().close = () => {
      modal().removeAttribute("open");
    };
    const button = trigger();
    synopsis.open(button, spec);
    synopsis.close();
    synopsis.open(button, spec);
    modal().dispatchEvent(new Event("close"));
    expect(modal().hidden).toBe(false);
    expect(modal().querySelector("p")?.textContent).toBe(spec.text);
  });

  it("falls back when native show or close throws and ignores detached triggers", () => {
    modal().showModal = () => {
      throw new Error("Unsupported");
    };
    synopsis.open(trigger(), spec);
    expect(modal().hasAttribute("open")).toBe(true);
    synopsis.close();
    modal().showModal = vi.fn();
    modal().close = () => {
      throw new Error("Host removed dialog");
    };
    const button = trigger();
    synopsis.open(button, spec);
    button.remove();
    synopsis.close();
    expect(modal().hidden).toBe(true);
    synopsis.open(button, spec);
    expect(modal().hidden).toBe(true);
  });

  it("disposes markup and listeners without resurrecting the dialog", () => {
    const button = trigger();
    synopsis.open(button, spec);
    synopsis.dispose();
    synopsis.dispose();
    expect(document.querySelector(".utv-synopsis-dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(document.body.style.overflow).toBe("auto");
    synopsis.open(button, spec);
    key("Escape");
    expect(document.querySelector(".utv-synopsis-dialog")).toBeNull();
  });
});
