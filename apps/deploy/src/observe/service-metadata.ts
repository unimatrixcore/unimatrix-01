import type { DeployStateResponse } from "@unimatrix/shared";

import type { DokployClient } from "../dokploy/client.js";
import { findComposeMatches } from "../reconcile/diff.js";

type ServiceMetadata = Pick<
  DeployStateResponse["apps"][number],
  "dokployUrl" | "domains" | "metadataObservedAt" | "metadataFreshness"
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
          metadata.set(app, {
            dokployUrl: publicUrl == null ? null : new URL(path, publicUrl).href,
            domains: compose.domains ?? null,
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
