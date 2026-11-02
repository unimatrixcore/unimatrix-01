import type { DeployStateResponse } from "@unimatrix/shared";

import type { DokployClient } from "../dokploy/client.js";
import { findComposeMatches } from "../reconcile/diff.js";
import { DEPLOY_PRIMARY_HOSTS } from "../reconcile/routing-policy.js";

type ServiceMetadata = Pick<
  DeployStateResponse["apps"][number],
  "dokployUrl" | "domains" | "primaryDomain" | "metadataObservedAt" | "metadataFreshness"
>;

export async function readServiceMetadata(
  client: Pick<DokployClient, "getProjects" | "getCompose">,
  apps: readonly string[],
  publicUrl: string | null | undefined,
  now: () => number = Date.now,
): Promise<ReadonlyMap<string, ServiceMetadata>> {
  const metadata = new Map<string, ServiceMetadata>();
  try {
    const projects = await client.getProjects();
    await Promise.all(
      apps.map(async (app) => {
        try {
          const matches = findComposeMatches(app, projects);
          if (matches.length !== 1) return;
          const match = matches[0]!;
          const compose = await client.getCompose(match.composeId);
          if (
            compose.composeId !== match.composeId ||
            compose.name !== app ||
            compose.owner !== "unimatrixcore" ||
            compose.repository !== "unimatrix-01"
          )
            return;
          const path = `/dashboard/project/${encodeURIComponent(match.projectId)}/environment/${encodeURIComponent(compose.environmentId)}/services/compose/${encodeURIComponent(compose.composeId)}`;
          const primaryHost = DEPLOY_PRIMARY_HOSTS[app];
          const primaryDomain =
            primaryHost === undefined
              ? compose.domains?.[0]
              : compose.domains?.find((domain) => domain.host.toLowerCase() === primaryHost);
          metadata.set(app, {
            dokployUrl: publicUrl == null ? null : new URL(path, publicUrl).href,
            domains: compose.domains ?? null,
            primaryDomain: primaryDomain ?? null,
            metadataObservedAt: now(),
            metadataFreshness: "fresh",
          });
        } catch {
          // A failed read must not disclose a rejected upstream value or imply no domains.
        }
      }),
    );
  } catch {
    // Missing metadata leaves container observations independently available.
  }
  return metadata;
}

export interface ServiceMetadataReaderOptions {
  budgetMs?: number;
  refreshIntervalMs?: number;
  now?: () => number;
}

export function createServiceMetadataReader(
  client: Pick<DokployClient, "getProjects" | "getCompose">,
  apps: readonly string[],
  publicUrl: string | null | undefined,
  { budgetMs = 250, refreshIntervalMs = 60_000, now = Date.now }: ServiceMetadataReaderOptions = {},
): { read: () => Promise<ReadonlyMap<string, ServiceMetadata>> } {
  const cached = new Map<string, ServiceMetadata>();
  let inFlight: Promise<void> | undefined;
  let nextRefreshAt = 0;

  return {
    read: async () => {
      if (!inFlight && now() >= nextRefreshAt) {
        nextRefreshAt = now() + refreshIntervalMs;
        inFlight = readServiceMetadata(client, apps, publicUrl, now)
          .then((metadata) => {
            for (const [app, value] of metadata) cached.set(app, value);
          })
          .finally(() => {
            inFlight = undefined;
          });
      }
      if (inFlight) {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            inFlight,
            new Promise<void>((resolve) => {
              deadline = setTimeout(resolve, budgetMs);
            }),
          ]);
        } finally {
          clearTimeout(deadline);
        }
      }
      const observedAt = now();
      return new Map(
        [...cached].map(([app, value]) => [
          app,
          {
            ...value,
            metadataFreshness:
              value.metadataObservedAt !== null &&
              observedAt >= value.metadataObservedAt &&
              observedAt - value.metadataObservedAt < refreshIntervalMs
                ? "fresh"
                : "stale",
          },
        ]),
      );
    },
  };
}
