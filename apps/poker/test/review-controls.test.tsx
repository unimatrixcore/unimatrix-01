import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decorateIconButton,
  enhanceCardCheckboxes,
  iconForButton,
  installCropPreview,
} from "../src/collector/review_controls.js";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("review control adapters", () => {
  it("keeps the native selection node and handler synchronized with the shared checkbox", async () => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = '<input type="checkbox" class="card-checkbox" aria-label="Select crop">';
    document.body.append(card);
    const input = card.querySelector<HTMLInputElement>("input")!;
    const changed = vi.fn();
    input.onchange = changed;
    act(() => {
      enhanceCardCheckboxes(card);
    });
    const check = screen.getByRole("checkbox", { name: "Select crop" });
    expect(check).not.toBeChecked();
    fireEvent.click(check);
    expect(changed).toHaveBeenCalledOnce();
    expect(input.checked).toBe(true);
    await waitFor(() => expect(check).toBeChecked());
    act(() => {
      input.checked = false;
    });
    await waitFor(() => expect(check).not.toBeChecked());
    act(() => {
      enhanceCardCheckboxes(card);
    });
    expect(card.querySelectorAll('[data-slot="checkbox"]')).toHaveLength(1);
  });

  it("tracks changing action labels without disturbing native callbacks or status", async () => {
    const host = document.createElement("span");
    host.innerHTML = '<button id="btn-add-db">Save all 2 crops</button>';
    document.body.append(host);
    const button = host.querySelector("button")!;
    const clicked = vi.fn();
    button.onclick = clicked;
    const icon = iconForButton(button)!;
    act(() => {
      decorateIconButton(button, icon);
    });
    expect(button).toHaveAccessibleName("Save all 2 crops");
    button.textContent = "Save all 1,917 crops";
    await waitFor(() => expect(button).toHaveAttribute("title", "Save all 1,917 crops"));
    fireEvent.click(button);
    expect(clicked).toHaveBeenCalledOnce();
    expect(host.querySelector("svg")).toBeInTheDocument();
    const aiHost = document.createElement("span");
    aiHost.innerHTML =
      '<button id="btn-ai-review">AI review<span id="ai-review-button-progress">Ready</span></button>';
    document.body.append(aiHost);
    const ai = aiHost.querySelector("button")!;
    act(() => {
      decorateIconButton(ai, iconForButton(ai)!);
    });
    expect(ai).toHaveAccessibleName("AI review");
    expect(aiHost.nextElementSibling).toHaveTextContent("Ready");
    expect(iconForButton(document.createElement("button"))).toBeUndefined();
  });

  it("bounds the pixelated preview to the viewport and hides it on release", () => {
    const card = document.createElement("div");
    card.className = "card";
    const source = document.createElement("img");
    source.src = "data:image/png;base64,AQID";
    Object.defineProperties(source, { naturalWidth: { value: 100 }, naturalHeight: { value: 50 } });
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 220,
      bottom: 120,
      width: 220,
      height: 120,
      toJSON: () => ({}),
    });
    card.append(source);
    document.body.append(card);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => source),
    });
    installCropPreview();
    fireEvent.mouseMove(window, { clientX: 100, clientY: 100 });
    fireEvent.keyDown(window, { key: "Shift" });
    const preview = document.querySelector<HTMLElement>(".crop-zoom-preview")!;
    expect(preview.hidden).toBe(false);
    expect(preview.style.width).toBe("400px");
    expect(preview.style.height).toBe("200px");
    fireEvent.keyUp(window, { key: "Shift" });
    expect(preview.hidden).toBe(true);
  });
});
