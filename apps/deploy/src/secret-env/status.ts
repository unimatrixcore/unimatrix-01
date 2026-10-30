import type { DeployDesiredEnvVar } from "@unimatrix/deploy-config";
import { SecretsClientError, type SecretsClient } from "@unimatrix/secrets/client";

import { RECONCILE_SELF_APP_DIR } from "../reconcile/apply.js";
import { DEPLOY_DESIRED_STATE } from "../reconcile/desired-state.gen.js";

/** 10 seconds — one shared deadline for every declared name, not one per name, matching
 *  `apps/api`'s `setupIntegrationCredentials` reasoning: a slow store should not multiply a
 *  timeout by the number of names an app declares. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Only a 404 is `unresolved`, and the narrowness is the point: the store's 404 conflates a name that
 * does not exist, one out of this token's scope, and one this token's capability cannot reach
 * (`apps/secrets/AGENTS.md` §3, `denySecretAccess`) — nothing on this side of the call can tell those
 * apart, so the message says that rather than guessing which one happened. Every other status is a
 * failed call, not an answer about a name: a 401 on a wrong token would otherwise report as three
 * names that do not resolve, which reads as a store problem and is a credential problem.
 */
const UNRESOLVED_MESSAGE =
  "not resolved — the store answers a missing name, one out of this token's scope, and one this " +
  "token's capability cannot reach with the same 404, so which of those this is cannot be told from here.";

/** One declared name paired with the store name it names — never a value. */
interface SecretEnvDeclaration {
  readonly name: string;
  readonly secretName: string;
}

export interface SecretEnvResolvedResult extends SecretEnvDeclaration {
  readonly outcome: "resolved";
  /**
   * Whether the resolved value contains a real newline. Secrets apply is line-oriented, so a
   * stored value with real newlines can never be written as-is — this is the fact that matters, not
   * the value. Never a length, never a prefix, never any other value-derived field.
   */
  readonly singleLine: boolean;
}

export interface SecretEnvUnresolvedResult extends SecretEnvDeclaration {
  readonly outcome: "unresolved";
  readonly message: string;
}

export interface SecretEnvErrorResult extends SecretEnvDeclaration {
  readonly outcome: "error";
  readonly message: string;
}

export type SecretEnvResult =
  SecretEnvResolvedResult | SecretEnvUnresolvedResult | SecretEnvErrorResult;

export interface RefusedSelfSecretEnvStatus {
  readonly outcome: "refused-self";
  readonly appDir: string;
}

export interface UnknownAppSecretEnvStatus {
  readonly outcome: "unknown-app";
  readonly appDir: string;
}

export interface NoDeclarationsSecretEnvStatus {
  readonly outcome: "no-declarations";
  readonly appDir: string;
}

export interface ResultsSecretEnvStatus {
  readonly outcome: "results";
  readonly appDir: string;
  readonly results: readonly SecretEnvResult[];
}

export type SecretEnvStatus =
  | RefusedSelfSecretEnvStatus
  | UnknownAppSecretEnvStatus
  | NoDeclarationsSecretEnvStatus
  | ResultsSecretEnvStatus;

function isSecretsStoreDeclaration(
  envVar: DeployDesiredEnvVar,
): envVar is DeployDesiredEnvVar & { readonly secretName: string } {
  return envVar.secretName !== undefined;
}

async function resolveOne(
  client: SecretsClient,
  declaration: SecretEnvDeclaration,
  signal: AbortSignal,
): Promise<SecretEnvResult> {
  try {
    const value = await client.getSecretValue(declaration.secretName, { signal });

    return { ...declaration, outcome: "resolved", singleLine: !value.reveal().includes("\n") };
  } catch (error) {
    if (error instanceof SecretsClientError && error.status === 404) {
      return { ...declaration, outcome: "unresolved", message: UNRESOLVED_MESSAGE };
    }

    return {
      ...declaration,
      outcome: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Read-only: resolves every `secretName` a declared app's manifest entry names, and nothing else.
 * Reads `DEPLOY_DESIRED_STATE` itself rather than taking it as a parameter — data flows manifest →
 * this module, and `src/reconcile/` never hands this function anything or receives anything back
 * from it (`test/reconcile-value-isolation.test.ts` pins the one-way boundary).
 *
 * Refuses `RECONCILE_SELF_APP_DIR` and an app absent from the manifest before any network call —
 * neither needs the store reachable to answer. `findComposeMatches` and the owner/repository
 * anchoring `apps/deploy/src/reconcile/apply.ts` uses are deliberately not reused here: nothing is
 * being written and no Dokploy compose row is touched, so there is no write to anchor.
 */
export async function resolveSecretEnvStatus(
  client: SecretsClient,
  appDir: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<SecretEnvStatus> {
  if (appDir === RECONCILE_SELF_APP_DIR) {
    return { outcome: "refused-self", appDir };
  }

  const service = DEPLOY_DESIRED_STATE.find((entry) => entry.appDir === appDir);

  if (service === undefined) {
    return { outcome: "unknown-app", appDir };
  }

  const declarations = service.env.filter(isSecretsStoreDeclaration);

  if (declarations.length === 0) {
    return { outcome: "no-declarations", appDir };
  }

  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const results = await Promise.all(
    declarations.map((declaration) => resolveOne(client, declaration, signal)),
  );

  return { outcome: "results", appDir, results };
}
