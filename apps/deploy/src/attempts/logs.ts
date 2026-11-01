import type { DeployAttemptRecord, DeployAttemptLogsResponse } from "@unimatrix/shared";

import type { DokployClient } from "../dokploy/client.js";
import type { DokployLogClient } from "../dokploy/log-client.js";
import { findComposeMatches } from "../reconcile/diff.js";

export function attemptDiagnosticLines(
  attempt: DeployAttemptRecord,
): NonNullable<DeployAttemptLogsResponse["diagnosticLines"]> {
  const lines: NonNullable<DeployAttemptLogsResponse["diagnosticLines"]> = [
    "▶ Deployment attempt accepted and recorded.",
  ];
  if (attempt.outcome === "already-current") {
    lines.push("Requested image already running; no deployment was queued.");
    return lines;
  }
  lines.push(
    attempt.trigger === "rollback"
      ? "Rollback targets a previously verified deployed image."
      : attempt.image === null
        ? "Manual redeploy uses the service configuration; no immutable target image was supplied."
        : "Immutable target image recorded from CI publication.",
  );
  lines.push(
    attempt.baseline === null
      ? "No baseline container was recorded; replacement cannot be verified."
      : "Baseline container recorded before deployment.",
  );
  if (attempt.tagWrite !== null)
    lines.push(
      {
        started: "Image tag update started." as const,
        acknowledged: "Image tag update acknowledged." as const,
        rejected: "✖ Image tag update rejected; no deployment was queued." as const,
        unknown: "Image tag update result is unknown; retry is blocked until resolved." as const,
      }[attempt.tagWrite],
    );
  if (attempt.queue !== null)
    lines.push(
      {
        started: "Deployment queue request started." as const,
        acknowledged:
          "Deployment queue request acknowledged; awaiting runtime verification." as const,
        rejected: "✖ Deployment queue request rejected." as const,
        unknown: "Deployment queue result is unknown; retry is blocked until resolved." as const,
      }[attempt.queue],
    );
  if (attempt.outcome === "landed")
    lines.push("✔ Requested image verified in a replacement container.");
  if (attempt.outcome === "recreated")
    lines.push("✔ Replacement container observed; deployed image remains unverified.");
  if (attempt.outcome === "timed-out") {
    lines.push("✖ Deployment did not verify before its deadline.");
    if (attempt.lateLandedAt !== null)
      lines.push("Requested image verified after the deployment deadline.");
    else if (attempt.recreatedAt != null)
      lines.push(
        "Replacement container observed after the deployment deadline; image remains unverified.",
      );
  }
  return lines;
}

export async function readAttemptLogs(
  attempt: DeployAttemptRecord,
  client: Pick<DokployClient, "getProjects" | "getCompose">,
  logs: DokployLogClient | undefined,
): Promise<DeployAttemptLogsResponse> {
  const identity = {
    app: attempt.app,
    attemptId: attempt.id,
    policy: "recognized-events-only" as const,
    diagnosticLines: attemptDiagnosticLines(attempt),
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
