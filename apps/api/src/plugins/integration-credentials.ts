import { createSecretsClient, SecretsClientError } from "@unimatrix/secrets/client";
import type { SecretValue } from "@unimatrix/secrets";
import { secretNameSchema } from "@unimatrix/shared";
import type { SecretRegistryEntry } from "@unimatrix/shared";
import type { FastifyInstance } from "fastify";

/**
 * `apps/secrets` returns a byte-identical 404 for an absent name, an
 * out-of-scope name, and a wrong-capability token (one construction site —
 * see `apps/secrets/src/modules/secrets/index.ts`). `denied` names that
 * conflation: it means "the store said no", not "the secret does not
 * exist" — an operator reading a `denied` name should check the service
 * token's scope before assuming the row is missing. `failed` is everything
 * else (network failure, timeout, 5xx, a malformed response).
 */
export interface RefreshResult {
  loaded: string[];
  denied: string[];
  failed: string[];
}

export interface IntegrationCredentials {
  /**
   * Takes the registry constant, not its name: a renamed entry is then a
   * compile error here rather than an `undefined` indistinguishable from a
   * credential the store never returned.
   */
  get(entry: SecretRegistryEntry): SecretValue | undefined;
  loadedAt: string | null;
  refresh(): Promise<RefreshResult>;
}

declare module "fastify" {
  interface FastifyInstance {
    integrationCredentials: IntegrationCredentials;
  }
}

export interface SetupIntegrationCredentialsOptions {
  entries: readonly SecretRegistryEntry[];
  fetch?: typeof globalThis.fetch;
  /** Test seam: names to fetch instead of the consumer's required entries. */
  names?: readonly string[];
}

/**
 * One deadline shared across every declared name, not a per-name timeout.
 * `refresh()` runs inside `onReady`, which Fastify fully awaits before
 * `listen()` binds the socket — a per-name timeout would multiply the
 * unreachable window by the name count, during which every route (public
 * content routes included) is unavailable. 10s is generous for a handful of
 * sequential-looking-but-actually-concurrent fetches to one internal service.
 */
const BOOT_DEADLINE_MS = 10_000;

/**
 * Registers `app.integrationCredentials` and an `onReady` hook that
 * populates it, or logs and returns without decorating when no store is
 * configured — following `setupAuth`'s no-op shape rather than decorating an
 * always-empty `get()` that would read as configured when it is not.
 *
 * The consumer supplies its required registry entries. Registry inventory
 * alone must never grant a service access to another consumer's credentials.
 */
export function setupIntegrationCredentials(
  app: FastifyInstance,
  options: SetupIntegrationCredentialsOptions,
): void {
  const { secretsStore } = app.runtimeConfig;

  if (secretsStore === null) {
    app.log.info(
      "Integration credentials are disabled: SECRETS_BASE_URL/SECRETS_SERVICE_TOKEN are not configured.",
    );
    return;
  }

  const names = options.names ?? options.entries.map((entry) => entry.name);

  // Loud and immediate rather than a per-refresh 404 the store would report
  // as `denied`. `packages/shared`'s own test asserts this over the whole
  // registry, so in production this can only fire on a name that never ran a
  // test — which is exactly when a boot failure is the cheapest outcome.
  for (const name of names) {
    if (!secretNameSchema.safeParse(name).success) {
      throw new Error(
        `Invalid API runtime configuration: the secret registry contains a malformed name ${JSON.stringify(name)}.`,
      );
    }
  }

  const client = createSecretsClient({
    baseUrl: secretsStore.baseUrl,
    serviceToken: secretsStore.serviceToken,
    // Never both: `createSecretsClient` throws when a fetch implementation and
    // a pin arrive together, and the test seam has to win so a test can run
    // against a plain-HTTP fake.
    ...(options.fetch === undefined
      ? secretsStore.caCertificatePem === null
        ? {}
        : { caCertificatePem: secretsStore.caCertificatePem }
      : { fetch: options.fetch }),
  });

  const cache = new Map<string, SecretValue>();

  const credentials: IntegrationCredentials = {
    get: (entry) => cache.get(entry.name),
    loadedAt: null,
    refresh: () => refresh(),
  };

  async function refresh(): Promise<RefreshResult> {
    const deadline = AbortSignal.timeout(BOOT_DEADLINE_MS);

    const outcomes = await Promise.allSettled(
      names.map(async (name) => {
        const value = await client.getSecretValue(name, { signal: deadline });
        return { name, value };
      }),
    );

    const result: RefreshResult = { loaded: [], denied: [], failed: [] };

    outcomes.forEach((outcome, index) => {
      // `names[index]` is always defined: `outcomes` is `Promise.allSettled`
      // over `names.map(...)`, so the two arrays are the same length.
      const name = names[index] as string;

      if (outcome.status === "fulfilled") {
        cache.set(name, outcome.value.value);
        result.loaded.push(name);
        return;
      }

      const reason: unknown = outcome.reason;
      const isDenied = reason instanceof SecretsClientError && reason.status === 404;

      if (isDenied) {
        result.denied.push(name);
      } else {
        result.failed.push(name);
      }

      // Never the value, and never the store's response body — only the
      // outcome and (best-effort) the failure's own status.
      app.log.warn(
        {
          name,
          outcome: isDenied ? "denied" : "failed",
          status: reason instanceof SecretsClientError ? reason.status : null,
        },
        "integration credential not loaded",
      );

      // The previously cached value, if any, is left untouched — a failed
      // refresh must not empty a working cache.
    });

    credentials.loadedAt = new Date().toISOString();

    if (names.length > 0 && result.loaded.length === 0) {
      app.log.error(
        { declared: names.length },
        "no integration credentials loaded from the secrets service",
      );
    }

    return result;
  }

  app.decorate("integrationCredentials", credentials);

  // `refresh()` never rejects (`Promise.allSettled` plus a synchronous tail),
  // so this never rejects `onReady` — measured on Fastify 5.10.0, a rejecting
  // `onReady` aborts `listen()` and the socket never binds.
  app.addHook("onReady", async () => {
    await refresh();
  });
}
