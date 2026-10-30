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
  previous: MatchedContainerObservation | undefined,
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

  const sameContainer = previous?.containerId === container.containerId;
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
      previous === undefined ? null : sameContainer ? previous.lastRecreatedAt : observedAt,
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
  onReadFailure: () => void = () => undefined,
): ContainerObserver {
  let snapshot: readonly ContainerObservation[] = desired.map(({ appDir }) => ({
    appDir,
    kind: "unknown",
    reason: "not-polled",
    observedAt: null,
  }));
  const lastMatched = new Map<string, MatchedContainerObservation>();
  let inFlight: Promise<readonly ContainerObservation[]> | null = null;

  function poll(): Promise<readonly ContainerObservation[]> {
    if (inFlight !== null) return inFlight;

    inFlight = (async () => {
      const observedAt = now();
      try {
        const containers = await client.getContainers();
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
          const observation = observeContainer(
            service.appDir,
            candidates,
            lastMatched.get(service.appDir),
            observedAt,
          );
          if (observation.kind === "matched") lastMatched.set(service.appDir, observation);
          return observation;
        });
      } catch {
        // A failed read is no evidence that the previously seen container is still running.
        snapshot = desired.map(({ appDir }) => ({
          appDir,
          kind: "unknown",
          reason: "poll-failed",
          observedAt,
        }));
        onReadFailure();
      }
      return snapshot;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return { poll, getSnapshot: () => snapshot };
}
