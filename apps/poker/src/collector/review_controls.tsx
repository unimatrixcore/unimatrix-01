import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Checkbox } from "@unimatrix/ui";
import {
  RiCheckboxMultipleLine,
  RiCheckboxMultipleBlankLine,
  RiDeleteBinLine,
  RiSave3Line,
  RiPencilLine,
  RiRobot2Line,
} from "@remixicon/react";
import "./review_controls.css";

const icons: Record<string, typeof RiSave3Line> = {
  "btn-review-select-all": RiCheckboxMultipleLine,
  "btn-review-deselect-all": RiCheckboxMultipleBlankLine,
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
  flushSync(() => {
    createRoot(icon).render(<Icon size={16} />);
  });
  const sync = () => {
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
    const card =
      pointer && document.elementFromPoint(pointer.clientX, pointer.clientY)?.closest(".card");
    const source = card?.querySelector<HTMLImageElement>("img");
    if (!shift || !pointer || !source || !source.naturalWidth || !source.naturalHeight) {
      preview.hidden = true;
      return;
    }
    const bounds = source.getBoundingClientRect();
    const ratio = source.naturalWidth / source.naturalHeight;
    const availableWidth = Math.max(1, innerWidth - 16),
      availableHeight = Math.max(1, innerHeight - 16);
    const contentWidth = Math.min(bounds.width - 20, (bounds.height - 20) * ratio);
    const desired = Math.max(80, contentWidth * 2);
    const width = Math.min(desired, availableWidth, availableHeight * ratio);
    const height = width / ratio;
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
  window.addEventListener("blur", () => {
    shift = false;
    update();
  });
}
