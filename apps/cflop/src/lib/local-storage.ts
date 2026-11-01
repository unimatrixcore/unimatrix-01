/**
 * The one place this app decides what its `localStorage` keys look like.
 *
 * Separate key families live behind it (`progress:<setId>`, `pool:<setId>`,
 * `pool-mode:<setId>`, `preview-mode:<scope>`, `algorithm-set`). Routing them
 * all through here is what keeps the legacy-prefix fallback below a single
 * implementation rather than one copy per family.
 */

/** Namespace for every key this app owns. */
const KEY_PREFIX = "cflop";

/**
 * The namespace used before the CFLOP rebrand.
 *
 * Reads fall through to it when the current key is absent, because the rename
 * would otherwise wipe every existing user's learned-case progress and training
 * pool — silently, with no error and nothing in the UI to suggest the data ever
 * existed. Writes only ever target {@link KEY_PREFIX}, so a user's first write
 * after the rename carries their data forward (each writer merges over a read)
 * and subsequent reads stop consulting the legacy key.
 *
 * Reading deliberately does not copy the value forward: reads happen in render
 * paths, and a read that writes is a worse trade than leaving a stale duplicate
 * key behind. A user who never writes again keeps reading correctly from the
 * legacy key forever, which is the outcome we want.
 */
const LEGACY_KEY_PREFIX = "cube-trainer";

/** Storage errors propagate so migration can stop before losing access to source data. */
export function readStoredValueFromStorage(storage: Storage, suffix: string): string | null {
  return (
    storage.getItem(`${KEY_PREFIX}:${suffix}`) ?? storage.getItem(`${LEGACY_KEY_PREFIX}:${suffix}`)
  );
}

export function writeStoredValueToStorage(storage: Storage, suffix: string, value: string): void {
  storage.setItem(`${KEY_PREFIX}:${suffix}`, value);
}

/** Removes only a current-key value written by an interrupted migration. */
export function removeStoredValueFromStorage(storage: Storage, suffix: string): void {
  storage.removeItem(`${KEY_PREFIX}:${suffix}`);
}

/**
 * Reads the value for `suffix`, falling back to the pre-rebrand key when the
 * current one has never been written.
 */
export function readStoredValue(suffix: string): string | null {
  try {
    return readStoredValueFromStorage(window.localStorage, suffix);
  } catch {
    return null;
  }
}

/** Writes `value` for `suffix`, always under the current key prefix. */
export function writeStoredValue(suffix: string, value: string): void {
  try {
    writeStoredValueToStorage(window.localStorage, suffix, value);
  } catch {
    // Storage can be unavailable (private browsing, quota). Every caller treats
    // its state as best-effort and safe to drop silently in that case.
  }
}
