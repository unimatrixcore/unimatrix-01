// A host-local CLI, same reasoning as apps/secrets/src/cli/service-token.ts: reading it holds no
// credential a route would need to protect, and it lives under src/ (not scripts/) because
// tsconfig.build.json excludes scripts/ and the production image has no tsx to run one with.
import type { DeployDesiredState } from "@unimatrix/deploy-config";
import type { SecretsClient } from "@unimatrix/secrets/client";

import { loadDeployRuntimeConfig } from "../config.js";
import { createDokployClient, loadDokployApiKey, type DokployClient } from "../dokploy/client.js";
import { createDokployEnvClient, type DokployEnvClient } from "../dokploy/env-client.js";
import {
  createDokployCreationClient,
  type DokployCreationClient,
} from "../dokploy/creation-client.js";
import {
  loadDokployCreationConfig,
  type DokployCreationConfig,
} from "../dokploy/creation-config.js";
import { openDokployCreationStore, type DokployCreationStore } from "../dokploy/creation-store.js";
import { createMissingService } from "../reconcile/create.js";
import { applySecretEnv } from "../secret-env/apply.js";
import { applyAppSettings } from "../reconcile/apply.js";
import { collectReconcileRun, type ReconcileRun } from "../reconcile/collect.js";
import { DEPLOY_DESIRED_STATE } from "../reconcile/desired-state.gen.js";
import { renderApplyOutcome, renderReconcileRun } from "../reconcile/report.js";
import { renderSecretEnvStatus } from "../secret-env/report.js";
import { resolveSecretEnvStatus } from "../secret-env/status.js";
import { createSecretsClientFromEnv } from "../secret-env/store.js";

const USAGE = [
  "Usage:",
  "  reconcile report",
  "  reconcile apply <app>",
  "  reconcile create <app>",
  "  reconcile secrets-status <app>",
  "  reconcile secrets-apply <app> [--overwrite]",
  "secrets-apply: exits 0 applied, 1 in-sync, 2 refused, 3 write status unknown,",
  "4 read failed, 5 verification failed. No deploy is triggered.",
  "create: requires DOKPLOY_ENVIRONMENT_ID and DOKPLOY_GITHUB_ID; exits 0 created and source verified,",
  "2 refused, 3 write status unknown, 4 read/store failure, 5 verification failed.",
  "It reserves the app durably before creating and never retries a reserved app.",
  "",
  "report diffs apps/deploy/src/reconcile/desired-state.gen.ts against Dokploy and prints the",
  "result. Read-only — creates, updates, and deploys nothing.",
  "",
  "apply writes composePath, branch, and autoDeploy for one declared app when they drift from the",
  "manifest — a single compose.update call, settings only. It never writes env, never calls",
  "compose.create, compose.deploy, or a domain route, and refuses a match outside this repository,",
  "a sourceType disagreement, or this service's own compose entry (a self-apply followed by a",
  "deploy would destroy the process performing the reconciliation). apply's success (exit 0) is not",
  "a sync assertion — it can succeed on an app report still exits 1 on, because report also finds",
  "env drift apply deliberately never touches.",
  "",
  "secrets-status resolves the secrets-store names one declared app's manifest entry names, against",
  "the store this service holds a read-only token for. It never writes anything, to the store or to",
  "Dokploy, and its output never carries a value, a length, or a prefix — only whether each declared",
  "name resolved, and whether a resolved value is single-line.",
  "",
  "Exit codes for report:",
  "  0  every declared app is in sync",
  "  1  at least one app needs a decision (missing, ambiguous, or drifted)",
  "  2  the run could not complete (bad usage, or a Dokploy call failed)",
  "",
  "Exit codes for apply — 0 and 1 are deliberately different, so a caller can always tell whether a",
  "write happened:",
  "  0  applied — a write occurred and every written setting was confirmed on the re-read",
  "  1  nothing to apply — settings already matched, so no write occurred",
  "  2  refused or not applicable — bad usage, unknown app, not matched (missing/ambiguous),",
  "     the service's own entry, a foreign-repository match, or sourceType drift",
  "  3  write status unknown — a write was attempted but its outcome could not be confirmed",
  "  4  the run could not complete for another reason (a Dokploy call failed outright)",
  "  5  applied but the post-write state does not match — compose.update returned a 200, but the",
  "     re-read still shows a written setting drifted (Dokploy silently drops an unrecognised field)",
  "",
  "Exit codes for secrets-status:",
  "  0  every declared name resolved",
  "  1  the app declares no secrets-store values",
  "  2  refused — bad usage, unknown app, this service's own entry, or the store is not configured",
  "  3  at least one declared name is unresolved — the store cleanly answered that it holds no",
  "     value this token can read for that name (missing, out of scope, or wrong capability — this",
  "     side of the call cannot tell those apart)",
  "  4  a call to the store failed outright for at least one declared name, or the run could not",
  "     complete for another reason",
].join("\n");

export interface ReconcileCliDeps {
  readonly client: DokployClient;
  readonly envClient?: DokployEnvClient;
  readonly creation?: {
    readonly client: DokployCreationClient;
    readonly store: Pick<DokployCreationStore, "reserve">;
    readonly config: DokployCreationConfig;
  };
  readonly desired: DeployDesiredState;
  readonly write: (line: string) => void;
  /**
   * `null` when the store is not configured — `SECRETS_BASE_URL`, `SECRETS_PLATFORM_READ_TOKEN`, or
   * `SECRETS_TLS_CERT_BASE64` absent, empty, or malformed. `T | null` rather than an optional field:
   * `exactOptionalPropertyTypes` (`packages/config-typescript/base.json`) forbids assigning `undefined`
   * to an optional property explicitly, which would force every test building this object to omit the
   * key instead of stating it.
   */
  readonly secretEnv: SecretsClient | null;
}

function needsADecision(run: ReconcileRun): boolean {
  return run.results.some(
    (result) =>
      result.outcome === "diffed" && (result.diff.verdict !== "matched" || !result.diff.inSync),
  );
}

/** Exit codes for `apply <app>` — see USAGE for what each means. */
const APPLY_EXIT_CODE = {
  applied: 0,
  "nothing-to-apply": 1,
  "refused-self": 2,
  "unknown-app": 2,
  "not-matched": 2,
  "refused-foreign-repo": 2,
  "refused-source-type": 2,
  "write-status-unknown": 3,
  error: 4,
  "applied-but-drifted": 5,
} as const;

async function runReport(deps: ReconcileCliDeps): Promise<number> {
  let run: ReconcileRun;

  try {
    run = await collectReconcileRun(deps.client, deps.desired);
  } catch (error) {
    deps.write(
      `reconcile report: could not complete — ${error instanceof Error ? error.message : String(error)}`,
    );

    return 2;
  }

  for (const line of renderReconcileRun(run)) {
    deps.write(line);
  }

  if (run.results.some((result) => result.outcome === "error")) {
    return 2;
  }

  return needsADecision(run) ? 1 : 0;
}

async function runApply(deps: ReconcileCliDeps, appDir: string): Promise<number> {
  const outcome = await applyAppSettings(deps.client, deps.desired, appDir);

  for (const line of renderApplyOutcome(outcome)) {
    deps.write(line);
  }

  return APPLY_EXIT_CODE[outcome.outcome];
}

async function runSecretsStatus(deps: ReconcileCliDeps, appDir: string): Promise<number> {
  if (deps.secretEnv === null) {
    deps.write(
      `${appDir}: REFUSED — the secrets store is not configured (SECRETS_BASE_URL, ` +
        "SECRETS_PLATFORM_READ_TOKEN, and SECRETS_TLS_CERT_BASE64 for an https:// base URL).",
    );

    return 2;
  }

  // No try/catch here: every per-name failure resolveSecretEnvStatus can produce is already caught
  // inside it and turned into that name's own "error" result (below) — an outright store-call
  // failure is exit 4 by way of that per-name outcome, not a rejected promise reaching this
  // function. An exception here would be a genuinely unanticipated bug, and {@link main}'s own
  // catch-all handles that the same way it handles one from report or apply.
  const status = await resolveSecretEnvStatus(deps.secretEnv, appDir);

  for (const line of renderSecretEnvStatus(status)) {
    deps.write(line);
  }

  switch (status.outcome) {
    case "refused-self":
    case "unknown-app":
      return 2;
    case "no-declarations":
      return 1;
    case "results":
      // "unresolved" (3) and "error" (4) are deliberately different exit codes, same distinction
      // {@link resolveSecretEnvStatus} draws per name: unresolved is the store cleanly answering "no"
      // (missing, out of scope, or wrong capability — indistinguishable from here), error is the call
      // itself failing outright. "error" wins when both are present in the same run.
      if (status.results.every((result) => result.outcome === "resolved")) return 0;
      if (status.results.some((result) => result.outcome === "error")) return 4;
      return 3;
  }
}

/**
 * Throws nothing — every failure, including a `project.all` call that fails outright, is caught
 * and turned into an exit code and a written line. {@link main} stays thin: this is the function
 * the tests drive.
 */
export async function runReconcileCli(
  argv: readonly string[],
  deps: ReconcileCliDeps,
): Promise<number> {
  const [subcommand] = argv;

  // Exact-length, so `reconcile report --apply` is a usage error rather than a silently ignored
  // flag, and so `reconcile apply` with no app name is a usage error rather than an undefined app.
  if (argv.length === 1 && subcommand === "report") {
    return runReport(deps);
  }

  if (argv.length === 2 && subcommand === "apply") {
    const appDir = argv[1];
    if (appDir !== undefined) {
      return runApply(deps, appDir);
    }
  }

  if (argv.length === 2 && subcommand === "create") {
    const appDir = argv[1];
    if (appDir !== undefined && deps.creation !== undefined) {
      const result = await createMissingService(
        deps.client,
        deps.creation.client,
        deps.creation.store,
        deps.desired,
        appDir,
        deps.creation.config,
      );
      deps.write(
        `${appDir}: ${result.outcome.toUpperCase()}${result.observed === undefined ? "" : ` (observed: ${result.observed})`}`,
      );
      return {
        created: 0,
        "refused-self": 2,
        "unknown-app": 2,
        "not-missing": 2,
        "invalid-target": 2,
        "already-attempted": 2,
        error: 4,
        "verification-failed": 5,
        "write-status-unknown": 3,
      }[result.outcome];
    }
    deps.write("REFUSED — service creation is not configured.");
    return 2;
  }

  if (
    subcommand === "secrets-apply" &&
    (argv.length === 2 || (argv.length === 3 && argv[2] === "--overwrite"))
  ) {
    const appDir = argv[1];
    if (appDir !== undefined && deps.secretEnv !== null && deps.envClient !== undefined) {
      const result = await applySecretEnv(
        deps.client,
        deps.envClient,
        deps.secretEnv,
        appDir,
        argv[2] === "--overwrite",
      );
      deps.write(
        `${appDir}: ${result.outcome.toUpperCase()}${result.keys.length ? ` (${result.keys.join(", ")})` : ""}`,
      );
      return {
        applied: 0,
        "in-sync": 1,
        refused: 2,
        "write-status-unknown": 3,
        error: 4,
        "verification-failed": 5,
      }[result.outcome];
    }
    deps.write("REFUSED — secrets apply is not configured.");
    return 2;
  }

  if (argv.length === 2 && subcommand === "secrets-status") {
    const appDir = argv[1];
    if (appDir !== undefined) {
      return runSecretsStatus(deps, appDir);
    }
  }

  deps.write(USAGE);

  return 2;
}

/**
 * Never throws: an absent, empty, or malformed store variable becomes `null` here rather than
 * reaching {@link main}'s catch-all, which exists for a Dokploy call failing outright, not for the
 * store being unconfigured. `runSecretsStatus` turns a `null` into its own refusal line and exit
 * code instead.
 */
function tryCreateSecretsClientFromEnv(): SecretsClient | null {
  try {
    return createSecretsClientFromEnv();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  let creationStore: DokployCreationStore | undefined;
  try {
    const config = loadDeployRuntimeConfig();
    const client = createDokployClient({
      baseUrl: config.dokployBaseUrl,
      apiKey: loadDokployApiKey(),
    });

    const argv = process.argv.slice(2);
    let creation: ReconcileCliDeps["creation"];
    if (argv.length === 2 && argv[0] === "create") {
      const creationConfig = loadDokployCreationConfig();
      try {
        creationStore = openDokployCreationStore(config.databasePath);
      } catch {
        process.stderr.write("reconcile create: could not open creation reservations.\n");
        process.exitCode = 4;
        return;
      }
      creation = {
        config: creationConfig,
        store: creationStore,
        client: createDokployCreationClient({
          baseUrl: config.dokployBaseUrl,
          apiKey: loadDokployApiKey(),
        }),
      };
    }
    // Only the secrets subcommands read a store variable — report and apply never do, so a store left
    // unconfigured cannot affect either of them.
    const secretEnv =
      argv[0] === "secrets-status" || argv[0] === "secrets-apply"
        ? tryCreateSecretsClientFromEnv()
        : null;

    process.exitCode = await runReconcileCli(argv, {
      client,
      desired: DEPLOY_DESIRED_STATE,
      secretEnv,
      ...(creation === undefined ? {} : { creation }),
      ...(argv[0] === "secrets-apply"
        ? {
            envClient: createDokployEnvClient({
              baseUrl: config.dokployBaseUrl,
              apiKey: loadDokployApiKey(),
            }),
          }
        : {}),
      write: (line) => {
        process.stdout.write(`${line}\n`);
      },
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  } finally {
    creationStore?.close();
  }
}

// Guarded so test/module-graph.test.ts can import this module — and so the coverage denominator
// keeps it — without making a network call.
if (import.meta.main) {
  await main();
}
