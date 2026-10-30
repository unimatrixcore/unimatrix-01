import type { DeployDesiredState } from "@unimatrix/deploy-config";

import type { DokployClient } from "../dokploy/client.js";
import type { DokployContainer } from "../dokploy/schemas.js";

export type UnknownContainerReason = "not-polled" | "no-match" | "ambiguous" | "poll-failed";

export interface UnknownContainerObservation {
  readonly appDir: string;
  readonly kind: "unknown";
  readonly reason: UnknownContainerReason;
  readonly observedAt: number | null;
}

export interface MatchedContainerObservation {
  readonly appDir: string;
  readonly kind: "matched";
  readonly observedAt: number;
  readonly containerId: string;
  readonly image: string;
  readonly state: string;
  /** Dokploy's human-readable Docker status. It describes uptime coarsely, not creation time. */
  readonly status: string;
  /** The response has no CreatedAt field, so exact container age is unavailable. */
  readonly containerAgeMs: null;
  readonly firstObservedAt: number;
  readonly lastRecreatedAt: number | null;
}

export type ContainerObservation = UnknownContainerObservation | MatchedContainerObservation;

export interface ContainerObserver {
  poll(): Promise<readonly ContainerObservation[]>;
  getSnapshot(): readonly ContainerObservation[];
}

function matchesImageRepository(image: string, repository: string): boolean {
  return (
    image === repository || image.startsWith(`${repository}:`) || image.startsWith(`${repository}@`)
  );
}

function observeContainer(
  appDir: string,
  candidates: readonly DokployContainer[],
  previous: ContainerObservation,
  observedAt: number,
): ContainerObservation {
  if (candidates.length !== 1) {
    return {
      appDir,
      kind: "unknown",
      reason: candidates.length === 0 ? "no-match" : "ambiguous",
      observedAt,
    };
  }

  const [container] = candidates;
  if (container === undefined || container.containerId.length === 0) {
    return { appDir, kind: "unknown", reason: "no-match", observedAt };
  }

  const sameContainer =
    previous.kind === "matched" && previous.containerId === container.containerId;
  return {
    appDir,
    kind: "matched",
    observedAt,
    containerId: container.containerId,
    image: container.image,
    state: container.state,
    status: container.status,
    containerAgeMs: null,
    firstObservedAt: sameContainer ? previous.firstObservedAt : observedAt,
    lastRecreatedAt:
      previous.kind === "matched" ? (sameContainer ? previous.lastRecreatedAt : observedAt) : null,
  };
}

/**
 * Image repository is the only stable app identity in docker.getContainers' observed payload.
 * A missing or competing image match cannot establish an app's container state. Snapshots are
 * process-local; a fresh observer has no evidence of recreation until it sees two known IDs.
 */
export function createContainerObserver(
  client: Pick<DokployClient, "getContainers">,
  desired: DeployDesiredState,
  now: () => number = Date.now,
): ContainerObserver {
  let snapshot: readonly ContainerObservation[] = desired.map(({ appDir }) => ({
    appDir,
    kind: "unknown",
    reason: "not-polled",
    observedAt: null,
  }));
  let inFlight: Promise<readonly ContainerObservation[]> | null = null;

  function poll(): Promise<readonly ContainerObservation[]> {
    if (inFlight !== null) return inFlight;

    inFlight = (async () => {
      const observedAt = now();
      try {
        const containers = await client.getContainers();
        const previous = new Map(snapshot.map((entry) => [entry.appDir, entry]));
        const imageCounts = new Map<string, number>();
        for (const service of desired) {
          imageCounts.set(service.image, (imageCounts.get(service.image) ?? 0) + 1);
        }

        snapshot = desired.map((service): ContainerObservation => {
          if ((imageCounts.get(service.image) ?? 0) > 1) {
            return {
              appDir: service.appDir,
              kind: "unknown",
              reason: "ambiguous",
              observedAt,
            };
          }
          const candidates = containers.filter((container) =>
            matchesImageRepository(container.image, service.image),
          );
          const prior = previous.get(service.appDir);
          if (prior === undefined) {
            return { appDir: service.appDir, kind: "unknown", reason: "not-polled", observedAt };
          }
          return observeContainer(service.appDir, candidates, prior, observedAt);
        });
      } catch {
        // A failed read is no evidence that the previously seen container is still running.
        snapshot = desired.map(({ appDir }) => ({
          appDir,
          kind: "unknown",
          reason: "poll-failed",
          observedAt,
        }));
      }
      return snapshot;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return { poll, getSnapshot: () => snapshot };
}
