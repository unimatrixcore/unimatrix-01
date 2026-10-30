import { createSecretsClient, type SecretsClient } from "@unimatrix/secrets/client";

/**
 * Every field here is read lazily, only when `secrets-status` or `secrets-apply` runs — never from
 * `src/config.ts`, which `loadDeployRuntimeConfig()` parses on every boot of this service. A missing
 * or empty value throws, same as `loadDokployApiKey` (`src/dokploy/client.ts:23`); that is safe here
 * only because nothing on `server.ts`'s boot path or `reconcile report`/`reconcile apply` ever calls
 * this module. See `apps/deploy/AGENTS.md`.
 */
export interface SecretsPlatformStoreEnv {
  SECRETS_BASE_URL?: string | undefined;
  SECRETS_TLS_CERT_BASE64?: string | undefined;
  SECRETS_PLATFORM_READ_TOKEN?: string | undefined;
}

/**
 * The token arrives via `docker exec --env-file` at invoke time, never as compose env — it is never
 * at rest in Dokploy's `env` column and never in `infra/docker/deploy-compose.yaml`. Read once here
 * and handed straight into `createSecretsClient`'s config, where it lives only in the closure that
 * builds; it never reaches `runtimeConfig`, which `src/app.ts` decorates onto the Fastify instance
 * and is therefore reachable from every handler and log call. This service holds no such instance —
 * the secrets commands are CLI-only — but the rule is the same one `loadDokployApiKey` follows.
 */
export function loadSecretsPlatformReadToken(env: SecretsPlatformStoreEnv = process.env): string {
  const value = env.SECRETS_PLATFORM_READ_TOKEN;

  if (value === undefined || value.trim().length === 0) {
    throw new Error("SECRETS_PLATFORM_READ_TOKEN must be set.");
  }

  return value.trim();
}

function parseSecretsBaseUrl(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error("SECRETS_BASE_URL must be set.");
  }

  const trimmedValue = value.trim();
  let parsed: URL;

  try {
    parsed = new URL(trimmedValue);
  } catch {
    throw new Error(
      `SECRETS_BASE_URL must be a valid URL. Received ${JSON.stringify(trimmedValue)}.`,
    );
  }

  // Through the parsed URL, never `startsWith` on the raw string — `HTTPS://secrets:3001` is a valid
  // URL whose `protocol` normalises to `https:` while a `startsWith` check on the original text reads
  // it as plain HTTP. `apps/api/src/config.ts` records the same reasoning for the same check.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `SECRETS_BASE_URL must use http:// or https://. Received ${JSON.stringify(trimmedValue)}.`,
    );
  }

  return trimmedValue;
}

/**
 * `Buffer.from` drops characters outside the base64 alphabet rather than throwing, so a mangled
 * paste would otherwise reach the TLS handshake as an opaque failure instead of failing here. Mirrors
 * `apps/api/src/config.ts`'s `parseSecretsCaCertificate` in substance.
 */
function decodeSecretsCaCertificate(value: string): string {
  const pem = Buffer.from(value, "base64").toString("utf8");

  if (!pem.includes("-----BEGIN")) {
    throw new Error(
      'SECRETS_TLS_CERT_BASE64 must be a base64-encoded PEM certificate. The decoded value contains no "-----BEGIN" line.',
    );
  }

  return pem;
}

/**
 * `caCertificatePem` tracks `baseUrl`'s scheme exactly — required for `https:`, refused for `http:` —
 * same rule `apps/api/src/config.ts`'s `parseSecretsStoreConfig` applies to the API's own connection
 * to this store.
 */
function resolveCaCertificatePem(
  baseUrl: string,
  encodedValue: string | undefined,
): string | undefined {
  const isHttps = new URL(baseUrl).protocol === "https:";

  if (isHttps && encodedValue === undefined) {
    throw new Error(
      "SECRETS_TLS_CERT_BASE64 must be set when SECRETS_BASE_URL is https:// — the store's " +
        "certificate is self-signed, so without it every read fails against the system trust store " +
        "at runtime rather than here.",
    );
  }

  if (!isHttps && encodedValue !== undefined) {
    throw new Error(
      "SECRETS_TLS_CERT_BASE64 must not be set when SECRETS_BASE_URL is http:// — the certificate " +
        "would be silently unused and the connection would stay in cleartext.",
    );
  }

  return encodedValue === undefined ? undefined : decodeSecretsCaCertificate(encodedValue);
}

/**
 * Builds the `SecretsClient` the secrets commands use, from the three lazily-read pieces above.
 * Throws on any of them being absent, empty, or malformed — the CLI's caller turns that throw into a
 * refusal (`the store is not configured`) rather than letting it reach `server.ts` or `reconcile
 * report`/`reconcile apply`, neither of which ever calls this function.
 *
 * Passes no `fetch`: `createSecretsClient` rejects a caller-supplied `fetch` together with
 * `caCertificatePem` (`packages/secrets/src/client.ts:127`), since a caller's `fetch` is free to
 * ignore the dispatcher that carries the pin. A test stubs the `SecretsClient` interface instead of
 * the transport, for the same reason.
 */
export function createSecretsClientFromEnv(
  env: SecretsPlatformStoreEnv = process.env,
): SecretsClient {
  const baseUrl = parseSecretsBaseUrl(env.SECRETS_BASE_URL);
  const serviceToken = loadSecretsPlatformReadToken(env);
  const caCertificatePem = resolveCaCertificatePem(baseUrl, env.SECRETS_TLS_CERT_BASE64);

  return createSecretsClient({
    baseUrl,
    serviceToken,
    ...(caCertificatePem === undefined ? {} : { caCertificatePem }),
  });
}
