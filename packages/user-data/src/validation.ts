import { dataKeySchema, dataNamespaceSchema } from "@unimatrix/shared";

/**
 * Validates a store's `namespace` against `@unimatrix/shared`'s
 * `dataNamespaceSchema` and returns it unchanged. Both the account and
 * guest adapters call this once, at store-creation time, so a malformed
 * namespace fails the same way (and as early as possible) regardless of
 * which adapter backs the store.
 */
export function assertValidNamespace(namespace: string): string {
  const result = dataNamespaceSchema.safeParse(namespace);

  if (!result.success) {
    throw new Error(
      `Invalid user-data namespace "${namespace}": must be a lowercase, hyphenated slug ` +
        "matching /^[a-z0-9][a-z0-9-]{0,63}$/.",
    );
  }

  return result.data;
}

/**
 * Validates a document/file `key` against `@unimatrix/shared`'s
 * `dataKeySchema` and returns it unchanged. Both adapters call this on
 * every `get`/`set`/`delete`/`upload`/`getBlob` call, so guest and account
 * stores reject the same malformed keys identically.
 */
export function assertValidKey(key: string): string {
  const result = dataKeySchema.safeParse(key);

  if (!result.success) {
    throw new Error(
      `Invalid user-data key "${key}": must be 1-128 characters matching ` +
        "/^[A-Za-z0-9._-]+$/.",
    );
  }

  return result.data;
}
