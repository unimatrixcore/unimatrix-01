export type ListTransport = "http" | "tauri";
export function resolveListTransport(explicit?: ListTransport): ListTransport {
  if (explicit) return explicit;
  return typeof window !== "undefined" &&
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ != null
    ? "tauri"
    : "http";
}
export interface SystemMemoryInfo {
  totalBytes: number;
  availableBytes: number;
}
export interface MemoryEnvironment {
  deviceMemory?: number;
  heapUsed?: number;
  heapLimit?: number;
  system?: SystemMemoryInfo;
  saveData?: boolean;
  effectiveType?: string;
}
export type PauseReason = "memory" | "network" | "limit" | null;
export interface ListPolicy {
  maxBackgroundItems: number;
  gcTime: number;
  pauseReason: PauseReason;
}
export function readMemoryEnvironment(): MemoryEnvironment {
  const nav =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & {
          deviceMemory?: number;
          connection?: { saveData?: boolean; effectiveType?: string };
        });
  const memory =
    typeof performance === "undefined"
      ? undefined
      : (
          performance as Performance & {
            memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
          }
        ).memory;
  return {
    ...(nav?.deviceMemory === undefined ? {} : { deviceMemory: nav.deviceMemory }),
    ...(nav?.connection?.saveData === undefined ? {} : { saveData: nav.connection.saveData }),
    ...(nav?.connection?.effectiveType === undefined
      ? {}
      : { effectiveType: nav.connection.effectiveType }),
    ...(memory ? { heapUsed: memory.usedJSHeapSize, heapLimit: memory.jsHeapSizeLimit } : {}),
  };
}
export function getListPolicy(
  environment: MemoryEnvironment,
  transport: ListTransport = resolveListTransport(),
): ListPolicy {
  const gb = environment.system
    ? environment.system.availableBytes / 1024 ** 3
    : (environment.deviceMemory ?? 4);
  const maxBackgroundItems = gb <= 2 ? 500 : gb < 8 ? 2_000 : 10_000;
  const pressure =
    (environment.heapLimit !== undefined &&
      environment.heapLimit > 0 &&
      (environment.heapUsed ?? 0) / environment.heapLimit > 0.75) ||
    (environment.system !== undefined &&
      environment.system.availableBytes <
        Math.max(256 * 1024 ** 2, environment.system.totalBytes * 0.1));
  const slow =
    transport === "http" &&
    (environment.saveData === true ||
      environment.effectiveType === "2g" ||
      environment.effectiveType === "slow-2g");
  return {
    maxBackgroundItems,
    gcTime: gb <= 2 || pressure ? 30_000 : 30 * 60_000,
    pauseReason: pressure ? "memory" : slow ? "network" : null,
  };
}
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"),
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export function waitForIdle(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const idle = typeof window !== "undefined" && "requestIdleCallback" in window;
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const handle = idle
      ? window.requestIdleCallback(finish, { timeout: 500 })
      : setTimeout(finish, 0);
    const abort = () => {
      if (idle) window.cancelIdleCallback(handle as number);
      else clearTimeout(handle);
      reject(
        signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

const backgroundLanes = new Map<"http" | "tauri", Promise<unknown>>();
export function runBackgroundTask<T>(
  task: () => Promise<T>,
  signal: AbortSignal,
  transport: "http" | "tauri",
  delayMs: number,
): Promise<T> {
  const previous = backgroundLanes.get(transport) ?? Promise.resolve();
  const scheduled = previous
    .catch(() => undefined)
    .then(async () => {
      signal.throwIfAborted();
      await abortableDelay(delayMs, signal);
      signal.throwIfAborted();
      return task();
    });
  backgroundLanes.set(transport, scheduled);
  void scheduled
    .finally(() => {
      if (backgroundLanes.get(transport) === scheduled) backgroundLanes.delete(transport);
    })
    .catch(() => undefined);
  return scheduled;
}
