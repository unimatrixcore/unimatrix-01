import type { DeployAttemptRecord, DeployAttemptLogsResponse } from "@unimatrix/shared";

import type { DokployClient } from "../dokploy/client.js";
import type { DokployLogClient } from "../dokploy/log-client.js";
import { findComposeMatches } from "../reconcile/diff.js";

export async function readAttemptLogs(
  attempt: DeployAttemptRecord,
  client: Pick<DokployClient, "getProjects" | "getCompose">,
  logs: DokployLogClient | undefined,
): Promise<DeployAttemptLogsResponse> {
  const identity = {
    app: attempt.app,
    attemptId: attempt.id,
    policy: "recognized-events-only" as const,
  };
  const unavailable = (
    reason: "unassociated" | "source-unavailable" | "ambiguous",
  ): DeployAttemptLogsResponse => ({ ...identity, status: "unavailable", reason });
  if (attempt.queueClaimedAt === null) return unavailable("unassociated");
  if (logs === undefined) return unavailable("source-unavailable");
  try {
    const matches = findComposeMatches(attempt.app, await client.getProjects());
    const [match] = matches;
    if (matches.length !== 1 || match === undefined) return unavailable("ambiguous");
    const compose = await client.getCompose(match.composeId);
    if (
      compose.composeId !== match.composeId ||
      compose.name !== attempt.app ||
      compose.owner !== "unimatrixcore" ||
      compose.repository !== "unimatrix-01"
    ) {
      return unavailable("unassociated");
    }
    const deployments = await logs.getDeployments(match.composeId);
    if (deployments.some((row) => row.composeId !== match.composeId))
      return unavailable("ambiguous");
    const candidates = deployments.filter((row) => row.title === `unimatrix-attempt:${attempt.id}`);
    const [source] = candidates;
    if (candidates.length === 0) return unavailable("unassociated");
    if (candidates.length !== 1 || source === undefined) return unavailable("ambiguous");
    if (source.logPath === null) return unavailable("source-unavailable");
    // Dokploy names log files to the second; two deployments can share and overwrite a path.
    if (deployments.filter((row) => row.logPath === source.logPath).length !== 1)
      return unavailable("ambiguous");
    const output = await logs.getLogs(source.deploymentId);
    if (output.empty) return unavailable("source-unavailable");
    return {
      ...identity,
      status: "available",
      events: output.events,
      withheld: output.withheld,
      truncated: output.truncated,
    };
  } catch {
    return unavailable("source-unavailable");
  }
}
