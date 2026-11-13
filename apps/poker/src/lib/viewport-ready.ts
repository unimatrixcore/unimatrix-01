const decoded = new WeakMap<HTMLImageElement, { src: string; promise: Promise<void> }>();

function visible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const scroller = element.closest('[role="list"]');
  const clip = scroller?.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth &&
    (!clip ||
      (rect.bottom > clip.top &&
        rect.top < clip.bottom &&
        rect.right > clip.left &&
        rect.left < clip.right))
  );
}

/** Wait for the first rendered viewport, independently of later background pages. */
export async function waitForViewport(
  host: HTMLElement,
  signal?: AbortSignal,
  timeout = 10000,
): Promise<boolean> {
  const deadline = performance.now() + timeout;
  const expectsList = host.hasAttribute("data-list-expected");
  while (!signal?.aborted && host.isConnected && performance.now() < deadline) {
    const state = host.querySelector<HTMLElement>("[data-list-state]");
    const revision = host.dataset.listRevision;
    const expected = host.hasAttribute("data-list-expected");
    if (expectsList && !expected) return false;
    const cards = [...host.querySelectorAll<HTMLElement>("[data-native-card]")].filter((card) =>
      visible(card.closest("[data-index]") ?? card),
    );
    const ready =
      !expected ||
      (state &&
        state.dataset.listRevision === host.dataset.listRevision &&
        state.dataset.listState !== "pending" &&
        (state.dataset.listState === "error" ||
          state.dataset.listCount === "0" ||
          (cards.length > 0 && cards.every((card) => card.firstElementChild))));
    if (ready) {
      const images = [...host.querySelectorAll("img")].filter(visible);
      if (images.every((image) => image.complete)) {
        const promises = images.map((image) => {
          if (!image.naturalWidth || !image.decode) return Promise.resolve();
          let entry = decoded.get(image);
          if (!entry || entry.src !== image.currentSrc) {
            entry = { src: image.currentSrc, promise: image.decode().catch(() => {}) };
            decoded.set(image, entry);
          }
          return entry.promise;
        });
        const remaining = Math.max(0, deadline - performance.now());
        let timer: ReturnType<typeof setTimeout> | undefined;
        let abort: (() => void) | undefined;
        const result = await Promise.race([
          Promise.all(promises).then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => {
              resolve(false);
            }, remaining);
            abort = () => {
              resolve(false);
            };
            signal?.addEventListener("abort", abort, { once: true });
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (abort) signal?.removeEventListener("abort", abort);
        if (!result || signal?.aborted || !host.isConnected) return false;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        const now = [...host.querySelectorAll("img")].filter(visible);
        if (
          host.dataset.listRevision !== revision ||
          state?.dataset.listRevision !== revision ||
          now.length !== images.length ||
          now.some((image, index) => image !== images[index] || !image.complete)
        )
          continue;
        return !signal?.aborted && host.isConnected;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
