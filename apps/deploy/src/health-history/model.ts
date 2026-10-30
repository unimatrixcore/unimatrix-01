import { z } from "zod";

export const PROBE_INTERVAL_MS = 60_000;
export const PROBE_TIMEOUT_MS = 5_000;
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * PROBE_INTERVAL_MS;
export const DAY_MS = 24 * 60 * PROBE_INTERVAL_MS;

export const healthObservationSchema = z.object({
  app: z.string().min(1),
  checkedAt: z.number().int().nonnegative().safe(),
  state: z.enum(["up", "down", "unknown"]),
});

export type HealthObservation = z.infer<typeof healthObservationSchema>;

export interface HealthSummary {
  from: number;
  to: number;
  upMs: number;
  downMs: number;
  unknownMs: number;
  uptimePercent: number | null;
  coveragePercent: number;
}

/** A sample covers at most one sampling interval; a missing next sample is not evidence of health. */
export function summarizeHealth(
  observations: readonly HealthObservation[],
  from: number,
  to: number,
): HealthSummary {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) {
    throw new Error("Health summary requires a positive, ordered time window.");
  }
  let upMs = 0;
  let downMs = 0;
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index]!;
    const next = observations[index + 1];
    const start = Math.max(from, observation.checkedAt);
    const end = Math.min(to, observation.checkedAt + PROBE_INTERVAL_MS, next?.checkedAt ?? to);
    const duration = Math.max(0, end - start);
    if (observation.state === "up") upMs += duration;
    if (observation.state === "down") downMs += duration;
  }
  const observedMs = upMs + downMs;
  return {
    from,
    to,
    upMs,
    downMs,
    unknownMs: to - from - observedMs,
    uptimePercent: observedMs === 0 ? null : (100 * upMs) / observedMs,
    coveragePercent: to === from ? 0 : (100 * observedMs) / (to - from),
  };
}
