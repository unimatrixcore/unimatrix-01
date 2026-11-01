import { PROBE_INTERVAL_MS } from "./model.js";
import { probeHealth, type HealthProbeTarget } from "./probe.js";
import type { HealthHistoryStore } from "./store.js";

export interface HealthMonitor {
  poll(): Promise<void>;
  stop(): Promise<void>;
}

export function createHealthMonitor(
  targets: readonly HealthProbeTarget[],
  store: HealthHistoryStore,
  now: () => number = Date.now,
  probe: typeof probeHealth = probeHealth,
  monotonicNow: () => number = () => performance.now(),
): HealthMonitor {
  const abort = new AbortController();
  let active: Promise<void> | undefined;
  return {
    poll() {
      if (abort.signal.aborted) return Promise.resolve();
      if (active) return active;
      active = Promise.allSettled(
        targets.map(async (target) => {
          const started = monotonicNow();
          const state = await probe(target, abort.signal);
          const durationMs = Math.max(0, Math.round(monotonicNow() - started));
          if (abort.signal.aborted) return;
          const checkedAt = now();
          store.record(
            { app: target.app, checkedAt, state, ...(state === "unknown" ? {} : { durationMs }) },
            checkedAt,
          );
        }),
      )
        .then((results) => {
          if (results.some((result) => result.status === "rejected"))
            throw new Error("Health observation failed.");
        })
        .finally(() => {
          active = undefined;
        });
      return active;
    },
    async stop() {
      abort.abort();
      await active;
    },
  };
}

export function startHealthPolling(
  monitor: HealthMonitor,
  onError: () => void,
  intervalMs = PROBE_INTERVAL_MS,
): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sample = async (): Promise<void> => {
    const started = performance.now();
    try {
      await monitor.poll();
    } catch {
      onError();
    } finally {
      if (!stopped)
        timer = setTimeout(
          () => void sample(),
          Math.max(1, intervalMs - (performance.now() - started)),
        );
    }
  };
  void sample();
  return async () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    await monitor.stop();
  };
}
