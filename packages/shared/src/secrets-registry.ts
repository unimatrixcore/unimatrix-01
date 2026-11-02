/**
 * Also reachable as `@unimatrix/shared/secrets-registry`, a subpath pointing
 * at this file directly rather than `dist` (see `package.json`'s `exports`).
 * Plain Node loads a `deploy.config.ts` importing that subpath with no build
 * — `infra/scripts/generate-deploy-config.mjs` runs before anything is
 * built — so every import in this file must stay type-only: Node's type
 * stripping does not remap a `.js` specifier to a `.ts` file, so a future
 * value import written with this repo's `.js` convention would break
 * `pnpm check:deploy-config` (measured).
 *
 * The subpath is safe for build-time consumers only. `packages/shared`
 * declares `files: ["dist"]` and is a runtime dependency of `apps/api`,
 * shipped via `pnpm deploy --prod --legacy`; runtime code must keep
 * importing this registry from `@unimatrix/shared`'s main entry, never from
 * this subpath — a runtime `src` import would typecheck, build, and fail
 * only inside the container, where `src` never ships.
 */
import type { SecretTier } from "./schemas/secrets.js";

/**
 * `consumedBy` is prose, read by an operator in the admin console before a
 * destructive action: what breaks if this credential is missing or wrong. It
 * is the reason this registry is code and not a comma-separated env var.
 *
 * What belongs here is a **key the deployment needs**, not only a value that
 * must stay hidden. The Clerk publishable key ships inside the `apps/admin`
 * and `apps/auth` bundles and is confidential from nobody, and it is still
 * listed: an operator
 * asking "what keys does this system take" is asking about the inventory, and
 * a key missing from it is a manual step nothing records.
 */
export interface SecretRegistryEntry {
  name: string;
  tier: SecretTier;
  consumedBy: string;
}

/**
 * Every entry is a named constant, and a consumer passes the constant rather
 * than the name — `app.integrationCredentials.get(GITHUB_TOKEN_SECRET)`. A
 * rename is then a compile error at the consumer instead of a runtime
 * `undefined` that the plugin's `denied` bucket would report as a credential
 * the store lacks.
 *
 * The declaration stays here rather than beside the code that consumes it
 * because consumers can share an integration: two modules needing the same
 * credential would leave neither owning the declaration.
 *
 * Every name must satisfy `secretNameSchema` — lowercase, no underscores, no
 * dots — or it can never be stored. `test/secrets-registry.test.ts` asserts
 * that over the whole registry, so a name that cannot be stored fails there
 * rather than at runtime.
 */
export const CLERK_SECRET_KEY_SECRET = {
  name: "platform/clerk-secret-key",
  tier: "platform",
  consumedBy:
    "apps/api's Clerk backend calls. Without it the API boots with auth and every account-scoped route disabled; with a wrong value every signed-in request fails.",
} as const satisfies SecretRegistryEntry;

export const CLERK_JWT_KEY_SECRET = {
  name: "platform/clerk-jwt-key",
  tier: "platform",
  consumedBy:
    "Networkless verification of Clerk session tokens in apps/api. A wrong value rejects every signed-in request, including the admin console's own.",
} as const satisfies SecretRegistryEntry;

/**
 * Public, and listed anyway — it is a key the deployment needs. Its value is
 * inlined into the `apps/admin` and `apps/auth` browser bundles at image
 * build, so anyone can read it out of a page; storing it buys no secrecy, only
 * a complete inventory. The console still never displays it, because the rule
 * that no value reaches the browser is worth more than the one exception it
 * would earn here.
 *
 * Note it reaches its three consumers under two different variable names and
 * through two different mechanisms, which is why nothing links this entry to
 * them in types: `VITE_CLERK_PUBLISHABLE_KEY` as an `ARG` default baked into
 * the generated Dockerfile for the two SPAs (`apps/<app>/deploy.config.ts`),
 * `CLERK_PUBLISHABLE_KEY` as container environment for `apps/api`. A deploy
 * pipeline that writes only container environment cannot deliver it to the
 * SPAs at all.
 */
export const CLERK_PUBLISHABLE_KEY_SECRET = {
  name: "platform/clerk-publishable-key",
  tier: "platform",
  consumedBy:
    "Clerk's browser SDK in apps/admin and apps/auth, inlined at image build, and apps/api's Clerk client. Public — it ships in those two bundles. A wrong value makes sign-in fail on both SPAs, and mismatches the API's instance.",
} as const satisfies SecretRegistryEntry;

/**
 * What the system expects to exist. The admin console lists this union'd with
 * whatever the store actually holds, so a credential the running code needs
 * and the store lacks is visible rather than simply absent.
 *
 * The Clerk keys still reach their actual consumers as environment variables and,
 * for the publishable key on the two SPAs, as an `ARG` default in the generated
 * Dockerfile — `apps/deploy`'s `reconcile secrets-status` reads a `platform`
 * name out of the store too, but only to report whether it resolves, never to
 * deliver it anywhere. They are declared here because the console's question
 * is what the system needs, not what some service currently fetches.
 */
export const SECRET_REGISTRY: readonly SecretRegistryEntry[] = [
  CLERK_SECRET_KEY_SECRET,
  CLERK_JWT_KEY_SECRET,
  CLERK_PUBLISHABLE_KEY_SECRET,
];

/**
 * Inventory of integration-tier names. Consumers select their required
 * registry entries separately; inventory membership does not grant access.
 *
 * Written `map` then `filter` rather than the more obvious `filter` then
 * `map`, because with the integration tier empty the second callback of that
 * order never runs and the package's 100% function-coverage floor fails on a
 * correct implementation.
 */
export function integrationSecretNames(): readonly string[] {
  return SECRET_REGISTRY.map((entry) => entry.name).filter(
    (name) => secretTierForName(name) === "integration",
  );
}

/**
 * `null` means unlisted — a name the store holds that nothing here declares.
 * That is a real state the console renders, not an error: a credential can be
 * created through the console or the host CLI without ever being declared.
 */
export function secretTierForName(name: string): SecretTier | null {
  return SECRET_REGISTRY.find((entry) => entry.name === name)?.tier ?? null;
}
