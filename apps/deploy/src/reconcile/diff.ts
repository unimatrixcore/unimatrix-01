import type { RoutingComparison } from "./routing-policy.js";
import type { DeployDesiredEnvVar, DeployDesiredService } from "@unimatrix/deploy-config";

import type {
  DokployCompose,
  DokployComposeEnvKeyState,
  DokployProject,
} from "../dokploy/schemas.js";

/**
 * The instance-wide policy every reconciled service is expected to hold, stated in
 * `docs/deployment.md`: every Compose service deploys from `main` in this repository (`:165-166`)
 * and `autoDeploy` stays off on every one of them (`:127`). Domains, watch paths and `composeFile`
 * are deliberately not part of this policy — see `apps/deploy/README.md`.
 */
export const RECONCILE_SOURCE_TYPE = "github";
export const RECONCILE_BRANCH = "main";
export const RECONCILE_AUTO_DEPLOY = false;

/**
 * `missing` — declared with no value in Dokploy. `optional-absent` — declared with a default and
 * no value in Dokploy, which is not drift. `build-arg-runtime-copy` — a Dokploy key whose value
 * was baked into the image at build time; its runtime copy is informational. `undeclared` — a
 * Dokploy key this app's manifest never names. No state ever carries a value, only a key.
 */
export type EnvFindingState =
  "set" | "blank" | "missing" | "optional-absent" | "undeclared" | "build-arg-runtime-copy";

export interface EnvFinding {
  readonly key: string;
  readonly state: EnvFindingState;
}

/** The closed set of non-credential Dokploy settings this diff compares. Adding a member — `env`
 *  included — is a visible type change, never an accident. */
export type ReconcileSetting = "composePath" | "sourceType" | "branch" | "autoDeploy";

export interface SettingFinding {
  readonly setting: ReconcileSetting;
  readonly declared: string;
  readonly actual: string;
}

export interface MatchedAppDiff {
  readonly verdict: "matched";
  readonly appDir: string;
  readonly composeId: string;
  readonly envFindings: readonly EnvFinding[];
  readonly settingFindings: readonly SettingFinding[];
  readonly inSync: boolean;
  readonly routing?: RoutingComparison;
}

export interface MissingAppDiff {
  readonly verdict: "missing";
  readonly appDir: string;
}

export interface AmbiguousAppDiff {
  readonly verdict: "ambiguous";
  readonly appDir: string;
  readonly matchCount: number;
}

export type AppDiff = MatchedAppDiff | MissingAppDiff | AmbiguousAppDiff;

export interface ComposeMatch {
  readonly projectId: string;
  readonly composeId: string;
}

/**
 * Matches the way CI's `Deploy` job resolves a service (`.github/workflows/ci.yml`'s jq): by name,
 * globally across every project Dokploy holds, not scoped to one project. A name that appears more
 * than once anywhere on the instance is `ambiguous`, never assumed unique.
 */
export function findComposeMatches(
  appDir: string,
  projects: readonly DokployProject[],
): readonly ComposeMatch[] {
  const matches: ComposeMatch[] = [];

  for (const project of projects) {
    for (const environment of project.environments) {
      for (const compose of environment.compose) {
        if (compose.name === appDir) {
          matches.push({ projectId: project.projectId, composeId: compose.composeId });
        }
      }
    }
  }

  return matches;
}

function normalizeComposePath(composePath: string): string {
  return composePath.startsWith("./") ? composePath.slice(2) : composePath;
}

function diffEnv(
  desiredEnv: readonly DeployDesiredEnvVar[],
  buildArgNames: readonly string[],
  actualEnv: readonly DokployComposeEnvKeyState[],
): EnvFinding[] {
  const actualBlankByKey = new Map(actualEnv.map((entry) => [entry.key, entry.blank]));
  const desiredKeys = new Set(desiredEnv.map((entry) => entry.name));
  const buildArgKeys = new Set(buildArgNames);
  const findings: EnvFinding[] = [];

  for (const envVar of desiredEnv) {
    const blank = actualBlankByKey.get(envVar.name);

    if (blank === undefined) {
      findings.push({ key: envVar.name, state: envVar.required ? "missing" : "optional-absent" });
    } else {
      findings.push({ key: envVar.name, state: blank ? "blank" : "set" });
    }
  }

  for (const actual of actualEnv) {
    if (!desiredKeys.has(actual.key)) {
      findings.push({
        key: actual.key,
        state: buildArgKeys.has(actual.key) ? "build-arg-runtime-copy" : "undeclared",
      });
    }
  }

  return findings.sort((a, b) => a.key.localeCompare(b.key));
}

function diffSettings(desiredComposePath: string, actual: DokployCompose): SettingFinding[] {
  const findings: SettingFinding[] = [];

  if (normalizeComposePath(actual.composePath) !== normalizeComposePath(desiredComposePath)) {
    findings.push({
      setting: "composePath",
      declared: desiredComposePath,
      actual: actual.composePath,
    });
  }

  if (actual.sourceType !== RECONCILE_SOURCE_TYPE) {
    findings.push({
      setting: "sourceType",
      declared: RECONCILE_SOURCE_TYPE,
      actual: actual.sourceType,
    });
  }

  if (actual.branch !== RECONCILE_BRANCH) {
    findings.push({
      setting: "branch",
      declared: RECONCILE_BRANCH,
      actual: actual.branch ?? "(unset)",
    });
  }

  // Only an exact `true` is drift — `null` (never configured) is treated the same as `false`.
  if (actual.autoDeploy === true) {
    findings.push({
      setting: "autoDeploy",
      declared: String(RECONCILE_AUTO_DEPLOY),
      actual: "true",
    });
  }

  return findings;
}

function isEnvFindingInSync(finding: EnvFinding): boolean {
  return (
    finding.state === "set" ||
    finding.state === "optional-absent" ||
    finding.state === "build-arg-runtime-copy"
  );
}

/**
 * Pure: no I/O, no Dokploy call. `matches` decides `missing`/`ambiguous`/`matched`; `detail` is
 * required exactly when `matches` holds one entry, and is never read otherwise.
 */
export function diffApp(
  desired: DeployDesiredService,
  matches: readonly ComposeMatch[],
  detail: DokployCompose | null,
): AppDiff {
  if (matches.length === 0) {
    return { verdict: "missing", appDir: desired.appDir };
  }

  if (matches.length > 1) {
    return { verdict: "ambiguous", appDir: desired.appDir, matchCount: matches.length };
  }

  if (detail === null) {
    throw new Error(
      `diffApp: exactly one Dokploy compose service matched "${desired.appDir}", but no compose ` +
        "detail was supplied to diff against.",
    );
  }

  const envFindings = diffEnv(desired.env, desired.buildArgNames, detail.env);
  const settingFindings = diffSettings(desired.composePath, detail);

  return {
    verdict: "matched",
    appDir: desired.appDir,
    composeId: detail.composeId,
    envFindings,
    settingFindings,
    inSync: envFindings.every(isEnvFindingInSync) && settingFindings.length === 0,
  };
}
