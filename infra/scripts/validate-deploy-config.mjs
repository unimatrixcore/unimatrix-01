#!/usr/bin/env node
//
// Validates every `apps/<app>/deploy.config.ts` before the generator ever
// writes a file from it.
//
// `packages/deploy-config`'s own `validateAppConfig()` covers what a config
// can fail on its own — see that package's `AGENTS.md`. This script adds
// everything that needs the filesystem or a `node-api` app's own runtime
// config loader, neither of which that package may import (a pkg -> app edge
// is a lint error under `boundaries.mjs`, and this script sits in no
// workspace, so it imports both by absolute path instead):
//
//   1. Pairing, both directions. Every `apps/*/Dockerfile` needs a
//      `deploy.config.ts`, and so does every `infra/docker/*-compose.yaml` —
//      the generator iterates *discovered configs*, never `apps/*`, so a
//      deleted app's compose file would otherwise sit un-generated and
//      un-checked forever. Also asserts a config's own `appDir` names the
//      directory it actually lives in: the compose service name, the
//      published image name and a static SPA's own `COPY` paths are all
//      derived from `appDir` inside the generator, so a mismatch here is what
//      would let them drift.
//   2. The node-api runtime-config probe. Builds the effective env — the
//      config's own `dockerfileEnv` overlaid by `composeEnv` — and feeds it to
//      that app's real runtime config loader (`NODE_API_CONFIG_PROBES` below),
//      so this cannot drift from the parser it is checking against. `NODE_ENV`
//      is checked first: outside production `apps/api`'s loader returns `null`
//      for Clerk instead of throwing, so probing a non-production effective
//      env would measure nothing.
//
// Fails closed on zero configs discovered, matching `check-coverage-drift.mjs`,
// and on a `node-api` config with no probe
// entry — the smaller fix of skipping the probe when there is no entry would
// fail *open* for every future node-api app, which this script must never do.
import { rootCertificates } from "node:tls";
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const appsDir = join(repoRoot, "apps");
const composeDir = join(repoRoot, "infra", "docker");

/**
 * Placeholders for a compose `${VAR}` reference with no default, used only to
 * build the env each `node-api` config's runtime-config loader is probed
 * with. A var whose parser validates a format needs an entry here that
 * satisfies it.
 */
/** Base64 of a one-line fake PEM. Both config loaders check for `-----BEGIN` and nothing more. */
const placeholderPem = (label) =>
  Buffer.from(`-----BEGIN ${label}-----\nplaceholder\n-----END ${label}-----\n`).toString("base64");

const PLACEHOLDERS = {
  CORS_ALLOWED_ORIGINS: "https://placeholder.example",
  // `<version>:<base64key>`; the key is 32 zero bytes base64-encoded — long
  // enough to pass `KEK_LENGTH` in packages/secrets/src/keyring.ts, obviously
  // not a real key.
  SECRETS_KEKS: "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  // https, so the probe exercises the branch production runs and the
  // certificate below is required rather than refused.
  SECRETS_BASE_URL: "https://secrets:3001",
  // Any http(s) URL passes apps/deploy's own parser; DEFAULT_PLACEHOLDER alone would fail it.
  DOKPLOY_BASE_URL: "http://dokploy:3000",
  // Three *distinct* values, and they have to stay distinct: apps/api's loader
  // refuses two secrets tokens that share a value, so the single
  // DEFAULT_PLACEHOLDER would fail this probe rather than pass it.
  SECRETS_SERVICE_TOKEN: "svc_placeholder_read",
  SECRETS_INTEGRATIONS_MANAGE_TOKEN: "svc_placeholder_integrations_manage",
  SECRETS_PLATFORM_WRITE_TOKEN: "svc_placeholder_platform_write",
  SECRETS_TLS_CERT_BASE64: placeholderPem("CERTIFICATE"),
  DEPLOY_TLS_CERT_BASE64: Buffer.from(rootCertificates[0]).toString("base64"),
  SECRETS_TLS_KEY_BASE64: placeholderPem("PRIVATE KEY"),
};
const DEFAULT_PLACEHOLDER = "placeholder";

/**
 * Every `node-api` app's own runtime-config loader, keyed by `appDir`. A
 * `node-api` config with no entry here fails closed (see below) rather than
 * silently skipping the probe — the smaller fix of probing only a hardcoded
 * `app === "api"` would fail *open* for every future node-api app.
 */
const NODE_API_CONFIG_PROBES = {
  api: { configPath: ["apps", "api", "src", "config.ts"], loaderName: "loadApiRuntimeConfig" },
  deploy: {
    configPath: ["apps", "deploy", "src", "config.ts"],
    loaderName: "loadDeployRuntimeConfig",
  },
  secrets: {
    configPath: ["apps", "secrets", "src", "config.ts"],
    loaderName: "loadSecretsRuntimeConfig",
  },
};

let failures = 0;
const fail = (msg) => {
  console.log(`  FAIL  ${msg}`);
  failures += 1;
};

console.log(
  "validate-deploy-config: every apps/*/Dockerfile and compose file needs a deploy.config.ts\n",
);

const appDirs = existsSync(appsDir)
  ? readdirSync(appsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  : [];

const appsWithDockerfile = appDirs.filter((app) => existsSync(join(appsDir, app, "Dockerfile")));
const appsWithConfig = appDirs.filter((app) => existsSync(join(appsDir, app, "deploy.config.ts")));

const composeApps = existsSync(composeDir)
  ? readdirSync(composeDir)
      .map((name) => /^(.+)-compose\.yaml$/u.exec(name)?.[1])
      .filter((name) => name !== undefined)
      .sort()
  : [];

for (const app of appsWithDockerfile) {
  if (!appsWithConfig.includes(app)) {
    fail(`apps/${app}/Dockerfile exists but apps/${app}/deploy.config.ts does not.`);
  }
}
for (const app of composeApps) {
  if (!appsWithConfig.includes(app)) {
    fail(
      `infra/docker/${app}-compose.yaml exists but apps/${app}/deploy.config.ts does not — an ` +
        `orphaned compose file the generator never writes or checks again.`,
    );
  }
}

if (appsWithConfig.length === 0) {
  fail("no apps/*/deploy.config.ts found — this check cannot pass vacuously");
  console.log(`\nvalidate-deploy-config: ${failures} failure(s).`);
  process.exit(1);
}

const { validateAppConfig } = await import(
  pathToFileURL(join(repoRoot, "packages", "deploy-config", "src", "index.ts")).href
);

const { SECRET_REGISTRY } = await import(
  pathToFileURL(join(repoRoot, "packages", "shared", "src", "secrets-registry.ts")).href
);

const registeredSecretNames = new Set(SECRET_REGISTRY.map((entry) => entry.name));

/** Resolves one compose env value to what the probe should see. */
function resolveComposeEnvValue(value) {
  // `generated` is baked into the compose file exactly as computed, so the
  // probe must read it rather than fall through to a placeholder: a
  // placeholder that happens to match today would go on passing after the
  // generator's output changed, which is the drift this probe exists to catch.
  if (value.kind === "literal" || value.kind === "generated") {
    const trimmed = value.value.trim();
    return /^".*"$/u.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
  }
  if (value.default !== undefined) return value.default;
  return PLACEHOLDERS[value.name] ?? DEFAULT_PLACEHOLDER;
}

let sawNodeApiConfig = false;

for (const app of appsWithConfig) {
  const configPath = join(appsDir, app, "deploy.config.ts");
  const mod = await import(pathToFileURL(configPath).href);
  const config = mod.default;

  // `typeof null === "object"`, so null has to be rejected by name or a
  // `export default null` reaches config.appDir below and throws a raw
  // TypeError instead of reporting this failure.
  if (config === null || typeof config !== "object") {
    fail(`apps/${app}/deploy.config.ts must have a default export.`);
    continue;
  }

  if (config.appDir !== app) {
    fail(
      `apps/${app}/deploy.config.ts declares appDir ${JSON.stringify(config.appDir)}, which does ` +
        `not match the directory it lives in. The compose service name, the published image name ` +
        `and a static SPA's own COPY paths are all derived from appDir, so a mismatch here is ` +
        `what lets them point at the wrong app.`,
    );
  }

  const schemaFailures = validateAppConfig(config);
  for (const message of schemaFailures) {
    fail(`apps/${app}/deploy.config.ts — ${message}`);
  }

  // Stop here when the shape is already wrong: the probe below reads
  // config.dockerfileEnv and config.composeEnv directly, so a malformed config
  // would throw a TypeError and bury the failures just reported.
  if (schemaFailures.length > 0) continue;

  if (config.kind !== "node-api") continue;

  // Every `secrets-store` value must name an entry that actually exists in
  // `SECRET_REGISTRY`. `DeploySecretRegistryEntry` is structural, so an inline
  // object literal satisfies it and carries an arbitrary name straight into the
  // generated desired state — where the next consumer will try to resolve it
  // against the store and find nothing. `packages/deploy-config` cannot make
  // this closed itself: it has no dependencies, so the only way it could hold
  // the set of valid names is a copy, and a copied registry is the drift this
  // reference exists to remove.
  for (const env of config.composeEnv) {
    if (env.value.kind !== "secrets-store") continue;
    if (registeredSecretNames.has(env.value.secret.name)) continue;
    fail(
      `apps/${app}/deploy.config.ts — composeEnv ${env.name} is sourced from secrets-store entry ` +
        `${JSON.stringify(env.value.secret.name)}, which is not in SECRET_REGISTRY. Import the ` +
        `exported constant from @unimatrix/shared/secrets-registry rather than writing the entry inline.`,
    );
  }
  sawNodeApiConfig = true;

  const probe = NODE_API_CONFIG_PROBES[app];
  if (probe === undefined) {
    fail(
      `apps/${app}/deploy.config.ts declares kind "node-api" but has no entry in ` +
        `NODE_API_CONFIG_PROBES (infra/scripts/validate-deploy-config.mjs) — add one rather than ` +
        `skipping the probe, or a broken runtime config for this app ships unnoticed.`,
    );
    continue;
  }

  const effectiveEnv = {};
  for (const entry of config.dockerfileEnv) effectiveEnv[entry.name] = entry.value;
  for (const entry of config.composeEnv)
    effectiveEnv[entry.name] = resolveComposeEnvValue(entry.value);

  if (effectiveEnv.NODE_ENV !== "production") {
    fail(
      `apps/${app}/deploy.config.ts — the effective NODE_ENV is ${effectiveEnv.NODE_ENV ?? "unset"}, ` +
        `not production. Outside production this app's runtime config loader may tolerate fields ` +
        `that are required in production, so the probe below would measure nothing.`,
    );
    continue;
  }

  const { [probe.loaderName]: loadRuntimeConfig } = await import(
    pathToFileURL(join(repoRoot, ...probe.configPath)).href
  );

  try {
    loadRuntimeConfig(effectiveEnv);
  } catch (error) {
    fail(`apps/${app}/deploy.config.ts — ${error.message}`);
  }
}

if (!sawNodeApiConfig) {
  console.log("  note  no node-api config found — the node-api probe did not run this time");
}

console.log("");

if (failures > 0) {
  console.log(`validate-deploy-config: ${failures} failure(s).`);
  process.exit(1);
}

console.log(`validate-deploy-config: OK (${appsWithConfig.length} deploy config(s)).`);
