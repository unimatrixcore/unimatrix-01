import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Checkbox } from "@unimatrix/ui";
import {
  RiCheckboxMultipleLine,
  RiCheckboxMultipleBlankLine,
  RiCheckboxIndeterminateLine,
  RiDeleteBinLine,
  RiSave3Line,
  RiPencilLine,
  RiRobot2Line,
} from "@remixicon/react";
import "./review_controls.css";

const icons: Record<string, typeof RiSave3Line> = {
  "btn-review-select-all": RiCheckboxMultipleLine,
  "btn-delete-session-selected": RiDeleteBinLine,
  "btn-add-db": RiSave3Line,
  "btn-ai-review": RiRobot2Line,
};

export function iconForButton(node: HTMLButtonElement) {
  if (icons[node.id]) return icons[node.id];
  if (node.closest(".card-meta")) {
    const text = node.textContent?.trim();
    if (text === "Edit") return RiPencilLine;
    if (text === "Save") return RiSave3Line;
    if (text === "Remove" || text === "Delete") return RiDeleteBinLine;
  }
  return undefined;
}

export function decorateIconButton(button: HTMLElement, Icon: typeof RiSave3Line) {
  const host = button.parentElement;
  if (!host) return;
  host.classList.add("review-icon-action");
  const ai = button.id === "btn-ai-review";
  if (ai) {
    const progress = button.querySelector("#ai-review-button-progress");
    if (progress) host.after(progress);
  }
  const icon = document.createElement("span");
  icon.className = "review-action-icon";
  icon.setAttribute("aria-hidden", "true");
  host.append(icon);
  const root = createRoot(icon);
  let renderedIcon: typeof Icon | undefined;
  const sync = () => {
    const selection =
      button.id === "btn-review-select-all" ? button.getAttribute("aria-pressed") : null;
    const CurrentIcon =
      selection === "true"
        ? RiCheckboxMultipleLine
        : selection === "mixed"
          ? RiCheckboxIndeterminateLine
          : selection === "false"
            ? RiCheckboxMultipleBlankLine
            : Icon;
    if (renderedIcon !== CurrentIcon) {
      renderedIcon = CurrentIcon;
      flushSync(() => {
        root.render(<CurrentIcon size={16} />);
      });
    }
    const label = ai ? "AI review" : button.textContent?.trim();
    if (label) {
      button.setAttribute("aria-label", label);
      button.title = label;
    }
  };
  sync();
  new MutationObserver(sync).observe(button, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-pressed"],
  });
}

export function enhanceCardCheckboxes(container: ParentNode) {
  for (const input of container.querySelectorAll<HTMLInputElement>(
    "input.card-checkbox:not([data-shared-checkbox])",
  )) {
    input.dataset.sharedCheckbox = "true";
    input.hidden = true;
    input.classList.add("review-native-checkbox");
    const host = document.createElement("span");
    host.className = "review-checkbox-host";
    input.after(host);
    const root = createRoot(host);
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")!;
    const render = () => {
      root.render(
        <Checkbox
          className="review-checkbox"
          checked={descriptor.get!.call(input) as boolean}
          aria-label={input.getAttribute("aria-label") || "Select crop"}
          onCheckedChange={(value) => {
            input.checked = value === true;
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }}
        />,
      );
    };
    Object.defineProperty(input, "checked", {
      configurable: true,
      get: () => descriptor.get!.call(input) as boolean,
      set: (value: boolean) => {
        descriptor.set!.call(input, value);
        render();
      },
    });
    flushSync(render);
  }
}

function objectOffset(position: string, free: number) {
  if (position === "left" || position === "top") return 0;
  if (position === "right" || position === "bottom") return free;
  if (position === "center") return free / 2;
  const terms = position
    .replace(/calc\(|\)/g, "")
    .replace(/\s+/g, "")
    .match(/[+-]?(?:\d*\.)?\d+(?:%|px)/g);
  if (!terms) return free / 2;
  return terms.reduce(
    (offset, term) => offset + Number.parseFloat(term) * (term.endsWith("%") ? free / 100 : 1),
    0,
  );
}

function renderedImageBounds(source: HTMLImageElement) {
  const bounds = source.getBoundingClientRect();
  const style = getComputedStyle(source);
  const px = (value: string) => Number.parseFloat(value) || 0;
  const left = bounds.left + px(style.borderLeftWidth) + px(style.paddingLeft);
  const top = bounds.top + px(style.borderTopWidth) + px(style.paddingTop);
  const width =
    bounds.width - (left - bounds.left) - px(style.borderRightWidth) - px(style.paddingRight);
  const height =
    bounds.height - (top - bounds.top) - px(style.borderBottomWidth) - px(style.paddingBottom);
  const contain = Math.min(width / source.naturalWidth, height / source.naturalHeight);
  let scale = 1;
  if (style.objectFit === "contain") scale = contain;
  if (style.objectFit === "cover")
    scale = Math.max(width / source.naturalWidth, height / source.naturalHeight);
  if (style.objectFit === "scale-down") scale = Math.min(1, contain);
  const fill = !style.objectFit || style.objectFit === "fill";
  const imageWidth = fill ? width : source.naturalWidth * scale;
  const imageHeight = fill ? height : source.naturalHeight * scale;
  const [x = "50%", y = "50%"] = style.objectPosition.match(/calc\([^)]+\)|[^\s]+/g) || [];
  return {
    left: left + objectOffset(x, width - imageWidth),
    top: top + objectOffset(y, height - imageHeight),
    width: imageWidth,
    height: imageHeight,
    clipLeft: left,
    clipTop: top,
    clipRight: left + width,
    clipBottom: top + height,
  };
}

export function installCropPreview() {
  const preview = document.createElement("div");
  preview.className = "crop-zoom-preview";
  preview.hidden = true;
  const image = document.createElement("img");
  image.alt = "";
  preview.append(image);
  document.body.append(preview);
  let pointer: MouseEvent | null = null;
  let shift = false;
  const update = () => {
    const target = pointer && document.elementFromPoint(pointer.clientX, pointer.clientY);
    const source = target instanceof HTMLImageElement && target.closest(".card") ? target : null;
    if (!shift || !pointer || !source || !source.naturalWidth || !source.naturalHeight) {
      preview.hidden = true;
      return;
    }
    const bounds = renderedImageBounds(source);
    if (
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      pointer.clientX < Math.max(bounds.left, bounds.clipLeft) ||
      pointer.clientX >= Math.min(bounds.left + bounds.width, bounds.clipRight) ||
      pointer.clientY < Math.max(bounds.top, bounds.clipTop) ||
      pointer.clientY >= Math.min(bounds.top + bounds.height, bounds.clipBottom)
    ) {
      preview.hidden = true;
      return;
    }
    const width = Math.min(260, Math.max(1, innerWidth - 16));
    const height = Math.min(160, Math.max(1, innerHeight - 16));
    let url: URL;
    try {
      url = new URL(source.getAttribute("data-full-res") || source.src, location.href);
    } catch {
      preview.hidden = true;
      return;
    }
    if (
      !["http:", "https:", "blob:", "pokerlab:", "asset:"].includes(url.protocol) &&
      !(
        url.protocol === "data:" &&
        /^data:image\/(?:png|jpeg|gif|webp|bmp|svg\+xml)(?:;|,)/i.test(url.href)
      )
    ) {
      preview.hidden = true;
      return;
    }
    image.src = url.href;
    image.style.width = `${bounds.width * 2}px`;
    image.style.height = `${bounds.height * 2}px`;
    image.style.left = `${(width - 2) / 2 - (pointer.clientX - bounds.left) * 2}px`;
    image.style.top = `${(height - 2) / 2 - (pointer.clientY - bounds.top) * 2}px`;
    preview.style.width = `${width}px`;
    preview.style.height = `${height}px`;
    preview.style.left = `${Math.max(8, Math.min(pointer.clientX - width / 2, innerWidth - width - 8))}px`;
    const above = pointer.clientY - height - 16;
    preview.style.top = `${above >= 8 ? above : Math.min(pointer.clientY + 16, innerHeight - height - 8)}px`;
    preview.hidden = false;
  };
  window.addEventListener("mousemove", (event) => {
    pointer = event;
    update();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Shift") {
      shift = true;
      update();
    }
  });
  window.addEventListener("keyup", (event) => {
    if (event.key === "Shift") {
      shift = false;
      update();
    }
  });
  document.addEventListener("mouseleave", () => {
    pointer = null;
    update();
  });
  window.addEventListener("resize", () => {
    preview.hidden = true;
  });
  window.addEventListener(
    "scroll",
    () => {
      preview.hidden = true;
    },
    true,
  );
  window.addEventListener("blur", () => {
    shift = false;
    update();
  });
}
