export interface SynopsisSpec {
  title: string;
  text: string;
}

export interface SynopsisDialog {
  open: (trigger: HTMLElement, spec: SynopsisSpec) => void;
  close: () => void;
  dispose: () => void;
}

let dialogSequence = 0;

export function createSynopsisDialog(): SynopsisDialog {
  const dialog = document.createElement("dialog");
  const id = `utv-synopsis-${++dialogSequence}`;
  dialog.className = "utv-synopsis-dialog";
  dialog.dataset.utvOwned = "true";
  dialog.setAttribute("aria-labelledby", `${id}-title`);
  dialog.setAttribute("aria-describedby", `${id}-text`);
  dialog.setAttribute("aria-modal", "true");
  dialog.hidden = true;
  const panel = document.createElement("div");
  panel.className = "utv-synopsis-panel";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "utv-synopsis-close";
  closeButton.setAttribute("aria-label", "Close synopsis");
  const icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "×";
  closeButton.append(icon);
  const title = document.createElement("h2");
  title.id = `${id}-title`;
  const text = document.createElement("p");
  text.id = `${id}-text`;
  panel.append(closeButton, title, text);
  dialog.append(panel);
  document.body.append(dialog);
  const listeners = new AbortController();
  let trigger: HTMLElement | null = null;
  let active = false;
  let disposed = false;
  let nativeModal = false;
  let previousOverflow = "";

  const finish = (restoreFocus: boolean) => {
    if (!active) return;
    active = false;
    const previousTrigger = trigger;
    trigger = null;
    nativeModal = false;
    dialog.hidden = true;
    dialog.removeAttribute("open");
    dialog.classList.remove("utv-synopsis-fallback");
    if (document.body.style.overflow === "hidden") document.body.style.overflow = previousOverflow;
    title.textContent = "";
    text.textContent = "";
    if (restoreFocus && previousTrigger?.isConnected) previousTrigger.focus();
  };
  const close = () => {
    if (!active) return;
    if (nativeModal && typeof dialog.close === "function") {
      try {
        dialog.close();
      } catch {
        dialog.removeAttribute("open");
      }
    }
    finish(true);
  };
  closeButton.addEventListener("click", close, { signal: listeners.signal });
  dialog.addEventListener(
    "cancel",
    (event) => {
      event.preventDefault();
      close();
    },
    { signal: listeners.signal },
  );
  dialog.addEventListener(
    "close",
    () => {
      if (!dialog.open) finish(true);
    },
    { signal: listeners.signal },
  );
  dialog.addEventListener(
    "click",
    (event) => {
      if (event.target === dialog) close();
    },
    { signal: listeners.signal },
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (!active) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (!nativeModal && event.key === "Tab") {
        event.preventDefault();
        closeButton.focus();
      }
    },
    { capture: true, signal: listeners.signal },
  );
  document.addEventListener(
    "focusin",
    (event) => {
      if (active && !nativeModal && event.target instanceof Node && !dialog.contains(event.target))
        closeButton.focus();
    },
    { signal: listeners.signal },
  );

  return {
    open(nextTrigger, spec) {
      if (disposed || !nextTrigger.isConnected) return;
      if (!active) {
        previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
      }
      trigger = nextTrigger;
      title.textContent = spec.title;
      text.textContent = spec.text;
      dialog.hidden = false;
      if (!active) {
        if (typeof dialog.showModal === "function") {
          try {
            dialog.showModal();
            nativeModal = true;
          } catch {
            nativeModal = false;
          }
        }
        if (!nativeModal) {
          dialog.setAttribute("open", "");
          dialog.classList.add("utv-synopsis-fallback");
        }
        active = true;
      }
      closeButton.focus();
    },
    close,
    dispose() {
      if (disposed) return;
      disposed = true;
      close();
      listeners.abort();
      dialog.remove();
    },
  };
}
