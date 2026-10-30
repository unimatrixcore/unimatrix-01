import type { ContainerObserver } from "./observer.js";

export const CONTAINER_POLL_INTERVAL_MS = 30_000;

/** Schedule the next sample only after the current one finishes. */
export function startContainerPolling(
  observer: Pick<ContainerObserver, "poll">,
  onError: (error: unknown) => void,
  intervalMs = CONTAINER_POLL_INTERVAL_MS,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const sample = async (): Promise<void> => {
    try {
      await observer.poll();
    } catch (error) {
      onError(error);
    } finally {
      if (!stopped) timer = setTimeout(() => void sample(), intervalMs);
    }
  };

  void sample();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
