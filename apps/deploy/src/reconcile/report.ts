import type { ApplyOutcome } from "./apply.js";
import type { AppDiff, EnvFindingState } from "./diff.js";
import type { ReconcileRun } from "./collect.js";

/**
 * Every render in this module — {@link renderReconcileRun} and {@link renderApplyOutcome} alike —
 * carries an env key and one of {@link EnvFindingState}'s states, never a value: nothing here
 * holds a field a value could ride on. `renderApplyOutcome`'s `applied` and `nothing-to-apply`
 * cases additionally always say apply never writes env, then list the non-in-sync env findings
 * `report` would show — an operator reading only the apply output must never conclude apply fixed
 * env drift it never touches.
 */

const ENV_STATE_LABEL: Record<EnvFindingState, string> = {
  set: "set",
  blank: "blank",
  missing: "missing",
  "optional-absent": "optional, absent",
  undeclared: "undeclared",
  "build-arg-runtime-copy": "build arg runtime copy (ignored; value is baked into image)",
};

function renderBuildArgCopies(diff: Extract<AppDiff, { verdict: "matched" }>): string[] {
  return diff.envFindings
    .filter((finding) => finding.state === "build-arg-runtime-copy")
    .map((finding) => `  env ${finding.key}: ${ENV_STATE_LABEL[finding.state]}`);
}

function renderAppDiff(appDir: string, diff: AppDiff): string[] {
  if (diff.verdict === "missing") {
    return [`${appDir}: MISSING — no Dokploy compose service named "${appDir}"`];
  }

  if (diff.verdict === "ambiguous") {
    return [
      `${appDir}: AMBIGUOUS — ${String(diff.matchCount)} Dokploy compose services named "${appDir}"`,
    ];
  }

  if (diff.inSync) {
    return [`${appDir}: IN SYNC`, ...renderBuildArgCopies(diff)];
  }

  const lines = [`${appDir}: DRIFT`];

  for (const finding of diff.envFindings) {
    if (finding.state === "set" || finding.state === "optional-absent") continue;
    lines.push(`  env ${finding.key}: ${ENV_STATE_LABEL[finding.state]}`);
  }

  for (const finding of diff.settingFindings) {
    lines.push(`  ${finding.setting}: declared ${finding.declared}, actual ${finding.actual}`);
  }

  return lines;
}

function renderNonInSyncEnvFindings(diff: AppDiff): string[] {
  if (diff.verdict !== "matched") return [];

  const lines: string[] = [];

  for (const finding of diff.envFindings) {
    if (
      finding.state === "set" ||
      finding.state === "optional-absent" ||
      finding.state === "build-arg-runtime-copy"
    )
      continue;
    lines.push(`  env ${finding.key}: ${ENV_STATE_LABEL[finding.state]}`);
  }

  return lines;
}

export function renderApplyOutcome(outcome: ApplyOutcome): readonly string[] {
  const appDir = outcome.appDir;

  switch (outcome.outcome) {
    case "refused-self":
      return [`${appDir}: REFUSED — apply refuses this service's own compose entry`];
    case "unknown-app":
      return [`${appDir}: UNKNOWN — not declared in the desired-state manifest`];
    case "not-matched":
      return [
        `${appDir}: NOT MATCHED — ${String(outcome.matchCount)} Dokploy compose services named "${appDir}"`,
      ];
    case "refused-foreign-repo":
      return [
        `${appDir}: REFUSED — matched service is anchored to ${outcome.owner ?? "(unset)"}/` +
          `${outcome.repository ?? "(unset)"}, not this repository`,
      ];
    case "refused-source-type":
      return [`${appDir}: REFUSED — sourceType drift is out of scope for apply`];
    case "nothing-to-apply":
      return [
        `${appDir}: NOTHING TO APPLY — settings already match; apply never writes env`,
        ...renderNonInSyncEnvFindings(outcome.diff),
      ];
    case "applied":
      return [
        `${appDir}: APPLIED — wrote ${outcome.written.join(", ")}; apply never writes env` +
          (outcome.needsDeploy ? " (a deploy is required for this to take effect)" : ""),
        ...renderNonInSyncEnvFindings(outcome.diff),
      ];
    case "applied-but-drifted":
      return [
        `${appDir}: APPLIED BUT DRIFTED — wrote ${outcome.written.join(", ")}, but the re-read` +
          " still shows it drifted; apply never writes env",
        ...renderAppDiff(appDir, outcome.diff).slice(1),
      ];
    case "write-status-unknown": {
      const rereadLine =
        outcome.rereadErrorMessage !== null
          ? `  the post-write re-read also failed — ${outcome.rereadErrorMessage}`
          : outcome.diff !== null && outcome.diff.verdict === "matched" && outcome.diff.inSync
            ? "  post-write state was re-read successfully: it is now in sync"
            : "  post-write state was re-read successfully:";

      return [
        `${appDir}: WRITE STATUS UNKNOWN — ${outcome.writeErrorMessage}`,
        rereadLine,
        ...(outcome.diff === null ? [] : renderAppDiff(appDir, outcome.diff).slice(1)),
      ];
    }
    case "error":
      return [`${appDir}: ERROR — ${outcome.errorMessage}`];
  }
}

/**
 * Never carries an env value, only a key and one of {@link EnvFindingState}'s states — the
 * type this renders holds no field that could carry one. Pure: no I/O.
 */
export function renderReconcileRun(run: ReconcileRun): readonly string[] {
  const lines: string[] = [];

  for (const result of run.results) {
    if (result.outcome === "error") {
      lines.push(`${result.appDir}: ERROR — ${result.errorMessage}`);
      continue;
    }

    lines.push(...renderAppDiff(result.appDir, result.diff));
  }

  return lines;
}
