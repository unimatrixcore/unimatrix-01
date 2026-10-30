export interface CardMenuAction {
  label: string;
  run: () => void | Promise<void>;
  disabled?: boolean;
}

export interface CardMenuSpec {
  label: string;
  actions: CardMenuAction[];
  valid?: () => boolean;
}

export interface CardMenu {
  open: (trigger: HTMLElement, spec: CardMenuSpec) => void;
  close: () => void;
  dispose: () => void;
}

let menuSequence = 0;

export function createCardMenu(): CardMenu {
  const popup = document.createElement("div");
  popup.id = `utv-card-menu-${++menuSequence}`;
  popup.className = "utv-card-menu";
  popup.dataset.utvOwned = "true";
  popup.setAttribute("role", "menu");
  popup.setAttribute("popover", "manual");
  popup.tabIndex = -1;
  popup.hidden = true;
  popup.style.position = "fixed";
  popup.style.margin = "0";
  popup.style.inset = "auto";
  document.body.append(popup);
  const listeners = new AbortController();
  let trigger: HTMLElement | null = null;
  let spec: CardMenuSpec | null = null;
  let buttons: HTMLButtonElement[] = [];
  let generation = 0;
  let disposed = false;
  let nativeOpen = false;
  let previousControls: string | null = null;
  let previousHaspopup: string | null = null;

  const enabled = () => buttons.filter((button) => !button.disabled);
  const restoreAttribute = (node: HTMLElement, name: string, value: string | null) => {
    if (value === null) node.removeAttribute(name);
    else node.setAttribute(name, value);
  };
  const dismiss = (restoreFocus: boolean) => {
    generation++;
    const previousTrigger = trigger;
    if (previousTrigger) {
      previousTrigger.setAttribute("aria-expanded", "false");
      restoreAttribute(previousTrigger, "aria-controls", previousControls);
      restoreAttribute(previousTrigger, "aria-haspopup", previousHaspopup);
    }
    trigger = null;
    spec = null;
    buttons = [];
    if (nativeOpen) {
      try {
        popup.hidePopover();
      } catch {
        // A host page can remove a popover before its adapter is disposed.
      }
      nativeOpen = false;
    }
    popup.hidden = true;
    popup.removeAttribute("aria-busy");
    popup.replaceChildren();
    if (restoreFocus && previousTrigger?.isConnected) previousTrigger.focus();
  };
  const valid = () => {
    try {
      return Boolean(trigger?.isConnected && (spec?.valid?.() ?? true));
    } catch {
      return false;
    }
  };
  const position = () => {
    if (!trigger) return;
    if (!valid()) {
      dismiss(false);
      return;
    }
    const bounds = trigger.getBoundingClientRect();
    const margin = 8;
    const width = Math.max(0, window.innerWidth - margin * 2);
    const height = Math.max(0, window.innerHeight - margin * 2);
    popup.style.maxWidth = `${width}px`;
    popup.style.maxHeight = `${height}px`;
    popup.style.overflowY = "auto";
    const menuBounds = popup.getBoundingClientRect();
    const menuWidth = Math.min(menuBounds.width, width);
    const menuHeight = Math.min(menuBounds.height, height);
    const below = window.innerHeight - bounds.bottom - margin;
    const above = bounds.top - margin;
    const placeAbove = menuHeight + margin > below && above > below;
    popup.dataset.placement = placeAbove ? "above" : "below";
    const top = placeAbove ? bounds.top - menuHeight - margin : bounds.bottom + margin;
    popup.style.left = `${Math.max(margin, Math.min(bounds.right - menuWidth, window.innerWidth - menuWidth - margin))}px`;
    popup.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - menuHeight - margin))}px`;
  };
  const invoke = async (action: CardMenuAction) => {
    if (!valid()) {
      dismiss(false);
      return;
    }
    const current = generation;
    buttons.forEach((button) => {
      button.disabled = true;
    });
    popup.setAttribute("aria-busy", "true");
    popup.focus();
    try {
      await action.run();
      if (generation === current) dismiss(popup.contains(document.activeElement));
    } catch {
      if (generation !== current) return;
      if (!valid()) {
        dismiss(false);
        return;
      }
      const error = document.createElement("div");
      error.className = "utv-card-menu-error";
      error.setAttribute("role", "alert");
      error.textContent = "Couldn't complete this action. Try again.";
      popup.querySelector(".utv-card-menu-error")?.remove();
      popup.append(error);
      buttons.forEach((button, index) => {
        button.disabled = spec?.actions[index]?.disabled ?? false;
      });
      enabled()[0]?.focus();
      position();
    } finally {
      if (generation === current) popup.removeAttribute("aria-busy");
    }
  };
  popup.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss(true);
        return;
      }
      const items = enabled();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      let next: HTMLButtonElement | undefined;
      if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
      if (event.key === "ArrowUp")
        next = items[index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length];
      if (event.key === "Home") next = items[0];
      if (event.key === "End") next = items.at(-1);
      if (next) {
        event.preventDefault();
        next.focus();
      }
    },
    { signal: listeners.signal },
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (
        trigger &&
        event.target instanceof Node &&
        !popup.contains(event.target) &&
        !trigger.contains(event.target)
      )
        dismiss(false);
    },
    { capture: true, signal: listeners.signal },
  );
  document.addEventListener(
    "focusin",
    (event) => {
      if (
        trigger &&
        event.target instanceof Node &&
        !popup.contains(event.target) &&
        !trigger.contains(event.target)
      )
        dismiss(false);
    },
    { signal: listeners.signal },
  );
  window.addEventListener("resize", position, { signal: listeners.signal });
  document.addEventListener("scroll", position, { capture: true, signal: listeners.signal });

  return {
    open(nextTrigger, nextSpec) {
      if (disposed) return;
      if (trigger === nextTrigger) {
        dismiss(true);
        return;
      }
      dismiss(false);
      trigger = nextTrigger;
      spec = nextSpec;
      previousControls = trigger.getAttribute("aria-controls");
      previousHaspopup = trigger.getAttribute("aria-haspopup");
      if (!valid()) {
        dismiss(false);
        return;
      }
      trigger.setAttribute("aria-haspopup", "menu");
      trigger.setAttribute("aria-controls", popup.id);
      trigger.setAttribute("aria-expanded", "true");
      popup.setAttribute("aria-label", spec.label);
      popup.removeAttribute("aria-busy");
      const opening = generation;
      buttons = spec.actions.map((action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "utv-card-menu-item";
        button.setAttribute("role", "menuitem");
        button.tabIndex = -1;
        button.disabled = action.disabled ?? false;
        button.textContent = action.label;
        button.addEventListener("click", () => {
          if (generation === opening) void invoke(action);
        });
        popup.append(button);
        return button;
      });
      popup.hidden = false;
      popup.setAttribute("popover", "manual");
      if (typeof popup.showPopover === "function") {
        try {
          popup.showPopover();
          nativeOpen = true;
        } catch {
          popup.removeAttribute("popover");
        }
      } else popup.removeAttribute("popover");
      position();
      if (trigger) (enabled()[0] ?? popup).focus();
    },
    close() {
      dismiss(true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      dismiss(popup.contains(document.activeElement));
      listeners.abort();
      popup.remove();
    },
  };
}
