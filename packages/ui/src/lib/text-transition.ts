export interface TextTransitionOptions {
  container?: HTMLElement;
  durationMs?: number;
  /** Animate the complete suggestion surface with an ordered out/replace/in cycle. */
  mode?: "text" | "container";
}

export interface TextTransition {
  pending: () => void;
  update: (text: string, options?: { immediate?: boolean }) => void;
  dispose: () => void;
}

/** Retain layout while pending; only the current update can finish an entrance. */
export function createTextTransition(
  element: HTMLElement,
  options: TextTransitionOptions = {},
): TextTransition {
  if (options.mode === "container" && options.container) {
    return createContainerTextTransition(element, options.container, options.durationMs ?? 300);
  }
  const originalOpacity = element.style.getPropertyValue("opacity");
  const originalPriority = element.style.getPropertyPriority("opacity");
  const originalAria = element.getAttribute("aria-hidden");
  const originalState = element.getAttribute("data-text-transition");
  const hadClass = element.classList.contains("um-text-transition");
  const duration = Number.isFinite(options.durationMs)
    ? Math.min(500, Math.max(0, options.durationMs!))
    : 180;
  const animations = new Set<Animation>();
  let waiting = false;
  let disposed = false;
  let generation = 0;
  element.classList.add("um-text-transition");

  const restoreVisibility = (): void => {
    if (originalOpacity) element.style.setProperty("opacity", originalOpacity, originalPriority);
    else element.style.removeProperty("opacity");
    if (originalAria === null) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", originalAria);
  };
  const cancel = (): void => {
    generation++;
    for (const animation of animations) animation.cancel();
    animations.clear();
  };
  const window = element.ownerDocument.defaultView;
  const onResize = (): void => {
    if (disposed) return;
    cancel();
    if (!waiting) element.dataset.textTransition = "settled";
  };
  window?.addEventListener("resize", onResize);
  const reduced = (): boolean =>
    element.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
    false;
  const animate = (
    target: HTMLElement,
    frames: Keyframe[],
    milliseconds: number,
    token: number,
  ): void => {
    if (typeof target.animate !== "function") return;
    const animation = target.animate(frames, {
      duration: milliseconds,
      easing: "cubic-bezier(.2,.7,.2,1)",
      fill: "both",
    });
    animations.add(animation);
    void animation.finished.then(
      () => {
        animations.delete(animation);
        animation.cancel();
        if (!disposed && token === generation && animations.size === 0)
          element.dataset.textTransition = "settled";
      },
      () => {
        animations.delete(animation);
      },
    );
  };
  return {
    pending(): void {
      if (disposed || waiting) return;
      cancel();
      waiting = true;
      element.dataset.textTransition = "pending";
      element.style.setProperty("opacity", "0");
      element.setAttribute("aria-hidden", "true");
    },
    update(text, updateOptions): void {
      if (disposed) return;
      if (!waiting && element.textContent === text && !updateOptions?.immediate) return;
      cancel();
      const token = generation;
      const before = options.container?.getBoundingClientRect();
      element.textContent = text;
      waiting = false;
      restoreVisibility();
      element.dataset.textTransition = "settled";
      if (
        updateOptions?.immediate ||
        duration === 0 ||
        reduced() ||
        typeof element.animate !== "function"
      )
        return;
      element.dataset.textTransition = "entering";
      animate(
        element,
        [
          { opacity: 0, transform: "translateY(3px)" },
          { opacity: originalOpacity || "1", transform: "translateY(0)" },
        ],
        duration,
        token,
      );
      if (options.container && before) {
        const after = options.container.getBoundingClientRect();
        // Growing through the old narrow width would wrap the incoming text mid-flight.
        // Shrinking stays at least as wide as the incoming label's final layout.
        if (Math.abs(before.height - after.height) < 0.5 && before.width - after.width > 0.5) {
          animate(
            options.container,
            [{ width: `${before.width}px` }, { width: `${after.width}px` }],
            Math.min(500, duration + 20),
            token,
          );
        }
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      window?.removeEventListener("resize", onResize);
      cancel();
      restoreVisibility();
      if (!hadClass) element.classList.remove("um-text-transition");
      if (originalState === null) element.removeAttribute("data-text-transition");
      else element.setAttribute("data-text-transition", originalState);
    },
  };
}

/** Keep the outgoing pixels intact until hidden; semantic actions belong to the caller. */
function createContainerTextTransition(
  element: HTMLElement,
  panel: HTMLElement,
  durationMs: number,
): TextTransition {
  const duration = Number.isFinite(durationMs) ? Math.min(500, Math.max(0, durationMs)) : 300;
  const originalStyle = ["opacity", "transform", "visibility", "pointer-events"].map(
    (name) =>
      [name, panel.style.getPropertyValue(name), panel.style.getPropertyPriority(name)] as const,
  );
  const originalAria = panel.getAttribute("aria-hidden");
  const originalState = element.getAttribute("data-text-transition");
  let phase: "hidden" | "exiting" | "entering" | "visible" = "hidden";
  let queued: string | null = null;
  let waiting = false;
  let disposed = false;
  let generation = 0;
  let animation: Animation | null = null;
  const reduced = (): boolean =>
    element.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
    false;
  const canAnimate = (): boolean =>
    duration > 0 && !reduced() && typeof panel.animate === "function";
  const cancel = (): void => {
    generation++;
    animation?.cancel();
    animation = null;
  };
  const hide = (): void => {
    phase = "hidden";
    panel.style.opacity = "0";
    panel.style.visibility = "hidden";
    panel.style.transform = "scale(.9) translateY(10px)";
    panel.style.pointerEvents = "none";
    panel.setAttribute("aria-hidden", "true");
    element.dataset.textTransition = waiting ? "pending" : "settled";
  };
  const animate = (frames: Keyframe[], milliseconds: number, complete: () => void): void => {
    const token = ++generation;
    const active = panel.animate(frames, {
      duration: milliseconds,
      easing: "cubic-bezier(.4,0,.2,1)",
      fill: "both",
    });
    animation = active;
    void active.finished.then(
      () => {
        if (disposed || token !== generation) return;
        animation = null;
        complete();
        active.cancel();
      },
      () => {
        /* Cancellation is owned by the next update or disposal. */
      },
    );
  };
  const commit = (immediate = false): void => {
    if (queued === null || disposed) return;
    const text = queued;
    queued = null;
    element.textContent = text;
    if (text === "") {
      hide();
      return;
    }
    panel.style.opacity = "1";
    panel.style.visibility = "visible";
    panel.style.transform = "scale(1) translateY(0)";
    panel.style.pointerEvents = "auto";
    if (originalAria === null) panel.removeAttribute("aria-hidden");
    else panel.setAttribute("aria-hidden", originalAria);
    phase = "visible";
    element.dataset.textTransition = "settled";
    if (!immediate && canAnimate()) {
      phase = "entering";
      element.dataset.textTransition = "entering";
      animate(
        [
          { opacity: 0, transform: "scale(.9) translateY(10px)" },
          { opacity: 1, transform: "scale(1) translateY(0)" },
        ],
        duration,
        () => {
          phase = "visible";
          element.dataset.textTransition = "settled";
        },
      );
    }
  };
  const exit = (): void => {
    if (phase === "hidden") {
      commit();
      return;
    }
    if (phase === "exiting") return;
    // Capture the current composited pose before cancelling an interrupted entrance.
    const style = element.ownerDocument.defaultView?.getComputedStyle(panel);
    const from = { opacity: style?.opacity || "1", transform: style?.transform || "none" };
    cancel();
    phase = "exiting";
    panel.style.pointerEvents = "none";
    panel.setAttribute("aria-hidden", "true");
    if (!canAnimate()) {
      hide();
      commit(true);
      return;
    }
    element.dataset.textTransition = "exiting";
    animate(
      [from, { opacity: 0, transform: "scale(.9) translateY(10px)" }],
      Math.min(150, duration),
      () => {
        hide();
        commit();
      },
    );
  };
  hide();
  return {
    pending(): void {
      if (disposed || waiting) return;
      waiting = true;
      queued = null;
      exit();
    },
    update(text, updateOptions): void {
      if (disposed) return;
      if (
        !waiting &&
        queued === null &&
        element.textContent === text &&
        !updateOptions?.immediate &&
        (phase !== "hidden" || text === "")
      )
        return;
      queued = text;
      waiting = false;
      if (updateOptions?.immediate || !canAnimate()) {
        cancel();
        hide();
        commit(true);
        return;
      }
      if (phase === "hidden") commit();
      else exit();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancel();
      queued = null;
      for (const [name, value, priority] of originalStyle) {
        if (value) panel.style.setProperty(name, value, priority);
        else panel.style.removeProperty(name);
      }
      if (originalAria === null) panel.removeAttribute("aria-hidden");
      else panel.setAttribute("aria-hidden", originalAria);
      if (originalState === null) element.removeAttribute("data-text-transition");
      else element.setAttribute("data-text-transition", originalState);
    },
  };
}
