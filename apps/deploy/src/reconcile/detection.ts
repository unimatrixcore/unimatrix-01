import type { DeployDesiredState } from "@unimatrix/deploy-config";
import {
  deployReconciliationResponseSchema,
  type DeployReconciliationResponse,
} from "@unimatrix/shared";

import type { DokployClient } from "../dokploy/client.js";
import { collectReconcileRun } from "./collect.js";

export const RECONCILE_INTERVAL_MS = 15 * 60_000;

export interface ReconciliationDetector {
  poll(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  snapshot(): DeployReconciliationResponse;
}

export function createReconciliationDetector(
  client: Pick<DokployClient, "getProjects" | "getCompose">,
  desired: DeployDesiredState,
  now: () => number = Date.now,
  intervalMs = RECONCILE_INTERVAL_MS,
): ReconciliationDetector {
  let status: DeployReconciliationResponse["status"] = "not-checked";
  let observedAt: number | null = null;
  let nextRunAt: number | null = null;
  let results: DeployReconciliationResponse["results"] = [];
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let stopped = false;

  function snapshot(): DeployReconciliationResponse {
    const checkedAt = now();
    return {
      checkedAt,
      policy: "scheduled-detection-explicit-apply",
      status,
      observedAt,
      nextRunAt,
      intervalMs,
      freshness:
        observedAt === null
          ? "missing"
          : checkedAt >= observedAt && checkedAt - observedAt < intervalMs
            ? "fresh"
            : "stale",
      results,
    };
  }

  function poll(): Promise<void> {
    if (inFlight !== null) return inFlight;
    if (stopped) return Promise.resolve();
    if (timer !== undefined) clearTimeout(timer);
    nextRunAt = null;
    status = "checking";
    inFlight = (async () => {
      try {
        const run = await collectReconcileRun(client, desired);
        // Validate before caching: a malformed upstream result must not poison later reads.
        results = deployReconciliationResponseSchema.parse({
          ...snapshot(),
          results: run.results.map((result) =>
            result.outcome === "error"
              ? { appDir: result.appDir, outcome: "error", reason: "read-failed" }
              : result,
          ),
        }).results;
        status = results.some((result) => result.outcome === "error") ? "read-failed" : "checked";
      } catch {
        // Discard upstream errors; they can contain rejected plaintext values.
        results = desired.map(({ appDir }) => ({
          appDir,
          outcome: "error",
          reason: "read-failed",
        }));
        status = "read-failed";
      }
      observedAt = now();
    })().finally(() => {
      inFlight = null;
      if (running) {
        nextRunAt = now() + intervalMs;
        timer = setTimeout(() => void poll(), intervalMs);
      }
    });
    return inFlight;
  }

  return {
    poll,
    snapshot,
    start() {
      if (running || stopped) return;
      running = true;
      void poll();
    },
    async stop() {
      stopped = true;
      running = false;
      nextRunAt = null;
      if (timer !== undefined) clearTimeout(timer);
      await inFlight;
    },
  };
}
