import type {
  DeployAttemptRecord,
  DeployReconciliationResponse,
  DeployStateResponse,
} from "@unimatrix/shared";

export function outcomeLabel(attempt: DeployAttemptRecord): string {
  if (attempt.outcome === "timed-out" && attempt.recreatedAt != null)
    return "Recreated late · image unverified";
  if (attempt.lateLandedAt !== null) return "Deployed late";
  return {
    incomplete: "In progress",
    queued: "Queued",
    landed: "Deployed",
    recreated: "Recreated · image unverified",
    failed: "Failed",
    "timed-out": "Not applied",
  }[attempt.outcome];
}

export function attemptNeedsAttention(attempt: DeployAttemptRecord): boolean {
  return (
    attempt.lateLandedAt === null &&
    attempt.recreatedAt == null &&
    (attempt.outcome === "failed" || attempt.outcome === "timed-out")
  );
}

export function formatTime(value: number | null): string {
  return value === null ? "Not observed" : new Date(value).toLocaleString();
}

export function durationLabel(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes > 0
    ? `${minutes}m ${Math.floor((ms % 60_000) / 1000)}s`
    : `${Math.floor(ms / 1000)}s`;
}

export function uptimeLabel(startedAt: number | null): string {
  if (startedAt === null) return "Uptime unknown";
  const minutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function reconciliationSummary(snapshot: DeployReconciliationResponse, app: string) {
  const result = snapshot.results.find((entry) => entry.appDir === app);
  let label = "Not checked";
  let showDetail = false;
  let count = 0;
  if (snapshot.status === "checking") label = "Checking";
  else if (
    (snapshot.status === "read-failed" && result === undefined) ||
    result?.outcome === "error"
  ) {
    label = "Check unavailable";
    showDetail = true;
  } else if (result?.outcome === "diffed") {
    if (result.diff.verdict === "matched") {
      count =
        result.diff.settingFindings.length +
        result.diff.envFindings.filter((entry) =>
          ["blank", "missing", "undeclared"].includes(entry.state),
        ).length;
      const routing = result.diff.routing;
      if (routing)
        count +=
          routing.missingHosts.length +
          routing.unexpectedHosts.length +
          Number(routing.portMismatch);
      label =
        count > 0
          ? `${count} need a decision`
          : routing?.status === "unavailable"
            ? "Routing check unavailable"
            : routing?.status === "not-declared"
              ? "Routing not declared"
              : "No detected drift";
      showDetail =
        !result.diff.inSync ||
        routing?.status === "unavailable" ||
        routing?.status === "not-declared";
    } else {
      label = result.diff.verdict === "missing" ? "Not created yet" : "Service mapping ambiguous";
      showDetail = true;
      count = 1;
    }
  }
  return { label, showDetail, count };
}

export function serviceStatus(container: DeployStateResponse["apps"][number]["container"]): {
  tone: "ok" | "warn" | "bad" | "idle";
  label: string;
} {
  if (container.kind === "unknown" || container.freshness !== "fresh")
    return { tone: "idle", label: "Unknown" };
  if (container.health === "unhealthy") return { tone: "bad", label: "Unhealthy" };
  if (container.health === "starting") return { tone: "warn", label: "Starting" };
  return container.state === "running"
    ? { tone: "ok", label: "Up" }
    : { tone: "bad", label: container.state };
}

export function shortTag(tag: string | null | undefined): string {
  if (!tag) return "Unknown tag";
  return /^[a-f0-9]{40}$/u.test(tag) ? tag.slice(0, 7) : tag;
}
