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

  function cropFixture(
    width: number,
    height: number,
    naturalWidth: number,
    naturalHeight: number,
    css = "",
  ) {
    const card = document.createElement("div");
    card.className = "card";
    const source = document.createElement("img");
    source.src =
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='50'/%3E";
    source.style.cssText = `padding:0;border:0;object-fit:fill;object-position:50% 50%;${css}`;
    Object.defineProperties(source, {
      naturalWidth: { value: naturalWidth },
      naturalHeight: { value: naturalHeight },
    });
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    });
    card.append(source);
    document.body.append(card);
    const hit = vi.fn((): Element | null => source);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hit });
    installCropPreview();
    const preview = document.querySelector<HTMLElement>(".crop-zoom-preview")!;
    const image = preview.querySelector("img")!;
    const move = (x: number, y: number) => fireEvent.mouseMove(window, { clientX: x, clientY: y });
    return { source, preview, image, move, hit };
  }

  it.each([
    {
      name: "wide",
      width: 400,
      height: 100,
      nw: 800,
      nh: 200,
      css: "",
      left: 0,
      top: 0,
      iw: 400,
      ih: 100,
    },
    {
      name: "tall",
      width: 100,
      height: 400,
      nw: 200,
      nh: 800,
      css: "",
      left: 0,
      top: 0,
      iw: 100,
      ih: 400,
    },
    {
      name: "upscaled",
      width: 400,
      height: 200,
      nw: 40,
      nh: 20,
      css: "",
      left: 0,
      top: 0,
      iw: 400,
      ih: 200,
    },
    {
      name: "asymmetric padding and borders",
      width: 430,
      height: 240,
      nw: 400,
      nh: 200,
      css: "padding: 10px 12px 20px 8px; border: 5px solid;",
      left: 13,
      top: 15,
      iw: 400,
      ih: 200,
    },
    {
      name: "wide contain letterbox",
      width: 400,
      height: 300,
      nw: 800,
      nh: 200,
      css: "object-fit: contain; object-position: 50% 25%;",
      left: 0,
      top: 50,
      iw: 400,
      ih: 100,
    },
    {
      name: "tall contain letterbox",
      width: 400,
      height: 300,
      nw: 200,
      nh: 600,
      css: "object-fit: contain; object-position: right bottom;",
      left: 300,
      top: 0,
      iw: 100,
      ih: 300,
    },
    {
      name: "edge offsets",
      width: 400,
      height: 300,
      nw: 200,
      nh: 600,
      css: "object-fit: contain; object-position: calc(100% - 20px) calc(100% - 10px);",
      left: 280,
      top: -10,
      iw: 100,
      ih: 300,
    },
    {
      name: "natural size",
      width: 400,
      height: 300,
      nw: 100,
      nh: 50,
      css: "object-fit: none; object-position: 20px 30px;",
      left: 20,
      top: 30,
      iw: 100,
      ih: 50,
    },
    {
      name: "scale down",
      width: 400,
      height: 300,
      nw: 100,
      nh: 50,
      css: "object-fit: scale-down; object-position: 50% 50%;",
      left: 150,
      top: 125,
      iw: 100,
      ih: 50,
    },
  ])(
    "centers and pans the sampled region for $name images",
    ({ width, height, nw, nh, css, left, top, iw, ih }) => {
      const { preview, image, move } = cropFixture(width, height, nw, nh, css);
      move(left + iw / 4, top + ih / 4);
      expect(preview.hidden).toBe(true);
      fireEvent.keyDown(window, { key: "Shift" });
      expect(preview.hidden).toBe(false);
      expect(preview.style.width).toBe("260px");
      expect(preview.style.height).toBe("160px");
      expect(image.style.width).toBe(`${iw * 2}px`);
      expect(image.style.height).toBe(`${ih * 2}px`);
      expect(Number.parseFloat(image.style.left) + (iw / 4) * 2).toBe(129);
      expect(Number.parseFloat(image.style.top) + (ih / 4) * 2).toBe(79);
      const first = image.style.left;
      move(left + (iw * 3) / 4, top + (ih * 3) / 4);
      expect(image.style.left).not.toBe(first);
      expect(Number.parseFloat(image.style.left) + ((iw * 3) / 4) * 2).toBe(129);
      expect(Number.parseFloat(image.style.top) + ((ih * 3) / 4) * 2).toBe(79);
      move(left - 1, top + ih / 2);
      expect(preview.hidden).toBe(true);
      move(left + iw / 2, top - 1);
      expect(preview.hidden).toBe(true);
    },
  );

  it("bounds the lens even on a small viewport and hides outside images, on release, leave and blur", () => {
    vi.stubGlobal("innerWidth", 200);
    vi.stubGlobal("innerHeight", 120);
    const { preview, move, hit } = cropFixture(200, 120, 20, 12);
    for (const [x, y] of [
      [1, 1],
      [199, 119],
    ]) {
      move(x!, y!);
      fireEvent.keyDown(window, { key: "Shift" });
      expect(preview.hidden).toBe(false);
      expect(preview.style.width).toBe("184px");
      expect(preview.style.height).toBe("104px");
      expect(Number.parseFloat(preview.style.left)).toBe(8);
      expect(Number.parseFloat(preview.style.top)).toBe(8);
    }
    hit.mockReturnValue(document.querySelector(".card"));
    move(20, 20);
    expect(preview.hidden).toBe(true);
    hit.mockReturnValue(document.querySelector(".card img"));
    move(20, 20);
    fireEvent.keyUp(window, { key: "Shift" });
    expect(preview.hidden).toBe(true);
    fireEvent.keyDown(window, { key: "Shift" });
    expect(preview.hidden).toBe(false);
    fireEvent.mouseLeave(document);
    expect(preview.hidden).toBe(true);
    move(20, 20);
    expect(preview.hidden).toBe(false);
    fireEvent.blur(window);
    expect(preview.hidden).toBe(true);
    vi.unstubAllGlobals();
  });

  it("retains image URL validation and native full-resolution sources", () => {
    const { source, preview, image, move } = cropFixture(400, 200, 100, 50);
    move(100, 100);
    fireEvent.keyDown(window, { key: "Shift" });
    expect(preview.hidden).toBe(false);
    for (const unsafe of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://[",
    ]) {
      source.setAttribute("data-full-res", unsafe);
      move(100, 100);
      expect(preview.hidden).toBe(true);
    }
    for (const url of [
      "pokerlab://localhost/api/crop/full.png",
      "asset://localhost/full.png",
      "/api/crop/full.png",
    ]) {
      source.setAttribute("data-full-res", url);
      move(100, 100);
      expect(preview.hidden).toBe(false);
      expect(image.src).toBe(new URL(url, location.href).href);
      expect(image.style.width).toBe("800px");
      expect(image.style.left).toBe("-71px");
    }
  });
});
