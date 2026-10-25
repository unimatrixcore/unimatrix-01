import type { SecretsClient, SecretValue } from "@unimatrix/secrets/client";

import type { DokployClient } from "../dokploy/client.js";
import type { DokployEnvClient } from "../dokploy/env-client.js";
import {
  RECONCILE_EXPECTED_OWNER,
  RECONCILE_EXPECTED_REPOSITORY,
  RECONCILE_SELF_APP_DIR,
} from "../reconcile/apply.js";
import { DEPLOY_DESIRED_STATE } from "../reconcile/desired-state.gen.js";
import { findComposeMatches, RECONCILE_SOURCE_TYPE } from "../reconcile/diff.js";
import { mergeSecretEnv } from "./merge.js";

export interface SecretEnvApplyResult {
  readonly outcome:
    "applied" | "in-sync" | "refused" | "error" | "write-status-unknown" | "verification-failed";
  readonly keys: readonly string[];
}

export async function applySecretEnv(
  client: DokployClient,
  envClient: DokployEnvClient,
  store: SecretsClient,
  appDir: string,
  overwrite = false,
): Promise<SecretEnvApplyResult> {
  const service = DEPLOY_DESIRED_STATE.find((entry) => entry.appDir === appDir);
  if (appDir === RECONCILE_SELF_APP_DIR || service === undefined)
    return { outcome: "refused", keys: [] };
  const declarations = service.env.flatMap((entry) =>
    entry.secretName === undefined ? [] : [{ name: entry.name, secretName: entry.secretName }],
  );
  if (declarations.length === 0) return { outcome: "in-sync", keys: [] };
  const resolved = new Map<string, SecretValue>();
  const failed: string[] = [];
  const signal = AbortSignal.timeout(10_000);
  await Promise.all(
    declarations.map(async (entry) => {
      try {
        resolved.set(entry.name, await store.getSecretValue(entry.secretName, { signal }));
      } catch {
        failed.push(entry.name);
      }
    }),
  );
  if (failed.length > 0) return { outcome: "refused", keys: failed };
  let attempted = false;
  try {
    const matches = findComposeMatches(appDir, await client.getProjects());
    const match = matches[0];
    if (matches.length !== 1 || match === undefined) return { outcome: "refused", keys: [] };
    const detail = await envClient.getComposeEnv(match.composeId);
    if (
      detail.composeId !== match.composeId ||
      detail.owner !== RECONCILE_EXPECTED_OWNER ||
      detail.repository !== RECONCILE_EXPECTED_REPOSITORY ||
      detail.sourceType !== RECONCILE_SOURCE_TYPE
    ) {
      return { outcome: "refused", keys: [] };
    }
    const merged = mergeSecretEnv(detail.env, resolved, overwrite);
    if (merged.refused.length > 0) return { outcome: "refused", keys: merged.refused };
    if (merged.changed.length === 0) return { outcome: "in-sync", keys: [] };
    attempted = true;
    let writeFailed = false;
    try {
      await envClient.updateComposeEnv(match.composeId, merged.env);
    } catch {
      writeFailed = true;
    }
    const observed = await envClient.getComposeEnv(match.composeId);
    if (writeFailed) return { outcome: "write-status-unknown", keys: merged.changed };
    const verified = mergeSecretEnv(observed.env, resolved, true);
    if (
      observed.composeId !== match.composeId ||
      verified.changed.length > 0 ||
      verified.refused.length > 0
    ) {
      return { outcome: "verification-failed", keys: [...verified.changed, ...verified.refused] };
    }
    return { outcome: "applied", keys: merged.changed };
  } catch {
    return { outcome: attempted ? "write-status-unknown" : "error", keys: [] };
  }
}
