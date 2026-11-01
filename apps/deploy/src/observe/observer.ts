import type { DeployAttemptRuntimeEvidence } from "@unimatrix/shared";
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
  /** Docker-only age stays unknown; bridge-derived start time travels separately. */
  readonly containerAgeMs: null;
  readonly name?: string | null;
  readonly startedAt?: number | null;
  readonly health?: "healthy" | "unhealthy" | "starting" | null;
  readonly imageTag?: string | null;
  readonly commit?: string | null;
  readonly commitSubject?: string | null;
  readonly runtimeMetadataObservedAt?: number | null;
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
  repository: string,
  candidates: readonly DokployContainer[],
  previous: MatchedContainerObservation | undefined,
  observedAt: number,
  evidence: readonly DeployAttemptRuntimeEvidence[],
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
  const runtimeMatches = evidence.filter(
    (entry) =>
      entry.app === appDir &&
      entry.image.repository === repository &&
      (entry.containerId === container.containerId ||
        (/^[a-f0-9]{12,63}$/u.test(container.containerId) &&
          /^[a-f0-9]{64}$/u.test(entry.containerId) &&
          entry.containerId.startsWith(container.containerId))),
  );
  const runtime = runtimeMatches.length === 1 ? runtimeMatches[0] : undefined;
  const metadata = runtime?.metadata;
  return {
    appDir,
    kind: "matched",
    observedAt,
    containerId: container.containerId,
    image: container.image,
    state: container.state,
    status: container.status,
    containerAgeMs: null,
    name: metadata?.name ?? container.name,
    startedAt: metadata?.startedAt ?? null,
    health: metadata?.health ?? null,
    imageTag:
      metadata?.imageTag ??
      (container.image.includes("@") || !container.image.includes(":")
        ? null
        : container.image.slice(container.image.lastIndexOf(":") + 1)),
    commit: metadata?.commit ?? null,
    commitSubject: metadata?.commitSubject ?? null,
    runtimeMetadataObservedAt: metadata === undefined ? null : runtime!.observedAt,
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
  readRuntimeEvidence: () => Promise<DeployAttemptRuntimeEvidence[]> = () => Promise.resolve([]),
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
        const evidence = await readRuntimeEvidence().catch(() => []);
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
            service.image,
            candidates,
            lastMatched.get(service.appDir),
            observedAt,
            evidence,
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
