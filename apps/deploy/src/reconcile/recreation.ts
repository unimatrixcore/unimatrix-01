import type { DeployDesiredState } from "@unimatrix/deploy-config";

import type { DokployClient } from "../dokploy/client.js";
import type {
  DokployRecreationClient,
  EnableRecreationResult,
} from "../dokploy/recreation-client.js";
import { RECONCILE_EXPECTED_OWNER, RECONCILE_EXPECTED_REPOSITORY } from "./apply.js";
import { findComposeMatches } from "./diff.js";

export interface RecreationSettingsOutcome {
  readonly appDir: string;
  readonly outcome: EnableRecreationResult | "unknown-app" | "not-matched" | "error";
}

export async function enableAppRecreation(
  client: Pick<DokployClient, "getProjects">,
  recreation: DokployRecreationClient,
  desired: DeployDesiredState,
  appDir: string,
): Promise<RecreationSettingsOutcome> {
  const declared = desired.find((entry) => entry.appDir === appDir);
  if (declared === undefined) return { appDir, outcome: "unknown-app" };
  try {
    const matches = findComposeMatches(appDir, await client.getProjects());
    const [match] = matches;
    if (matches.length !== 1 || match === undefined) return { appDir, outcome: "not-matched" };
    const row = await recreation.inspect(match.composeId);
    if (
      row.composeId !== match.composeId ||
      row.name !== appDir ||
      row.owner !== RECONCILE_EXPECTED_OWNER ||
      row.repository !== RECONCILE_EXPECTED_REPOSITORY ||
      row.sourceType !== "github" ||
      row.composePath.replace(/^\.\//u, "") !== declared.composePath
    )
      return { appDir, outcome: "refused" };
    return { appDir, outcome: await recreation.enable(row) };
  } catch {
    return { appDir, outcome: "error" };
  }
}
