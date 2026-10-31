import type { DeployDesiredState } from "@unimatrix/deploy-config";

import type { DokployClient } from "../dokploy/client.js";
import { diffApp, findComposeMatches, type AppDiff } from "./diff.js";

export interface DiffedAppRunResult {
  readonly appDir: string;
  readonly outcome: "diffed";
  readonly diff: AppDiff;
}

export interface ErrorAppRunResult {
  readonly appDir: string;
  readonly outcome: "error";
  /** A message from `DokployClientError`, never a response-body fragment (see that class in
   *  `../dokploy/client.js`). */
  readonly errorMessage: string;
}

export type AppRunResult = DiffedAppRunResult | ErrorAppRunResult;

export interface ReconcileRun {
  readonly results: readonly AppRunResult[];
}

/**
 * Fetches `project.all` once, then `compose.one` once per app with exactly one Dokploy match.
 * A `compose.one` failure is isolated to its own app — the run keeps going and reports every other
 * app — while a `project.all` failure aborts the whole run, since nothing here can be matched
 * without it; the caller (`../cli/reconcile.ts`) is what turns either into an exit code.
 */
export async function collectReconcileRun(
  client: Pick<DokployClient, "getProjects" | "getCompose">,
  desired: DeployDesiredState,
): Promise<ReconcileRun> {
  const projects = await client.getProjects();

  const results: AppRunResult[] = [];

  for (const service of desired) {
    const matches = findComposeMatches(service.appDir, projects);

    const [onlyMatch] = matches;

    if (matches.length !== 1 || onlyMatch === undefined) {
      results.push({
        appDir: service.appDir,
        outcome: "diffed",
        diff: diffApp(service, matches, null),
      });
      continue;
    }

    try {
      const detail = await client.getCompose(onlyMatch.composeId);
      results.push({
        appDir: service.appDir,
        outcome: "diffed",
        diff: diffApp(service, matches, detail),
      });
    } catch (error) {
      results.push({
        appDir: service.appDir,
        outcome: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { results };
}
