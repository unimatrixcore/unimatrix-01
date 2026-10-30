import type { FastifyInstance } from "fastify";

import { createHealthMonitor, startHealthPolling } from "./monitor.js";
import type { HealthProbeTarget } from "./probe.js";
import { openHealthHistoryStore, type HealthHistoryStore } from "./store.js";

declare module "fastify" {
  interface FastifyInstance {
    healthHistory: HealthHistoryStore;
  }
}

export function setupHealthMonitoring(
  app: FastifyInstance,
  path: string,
  targets: readonly HealthProbeTarget[],
): void {
  const store = openHealthHistoryStore(
    path,
    targets.map((target) => target.app),
  );
  const monitor = createHealthMonitor(targets, store);
  let stop: (() => Promise<void>) | undefined;
  app.decorate("healthHistory", store);
  app.addHook("onListen", () => {
    stop = startHealthPolling(monitor, () => {
      app.log.warn("health history poll failed");
    });
    return Promise.resolve();
  });
  app.addHook("onClose", async () => {
    try {
      await stop?.();
    } finally {
      store.close();
    }
  });
}
