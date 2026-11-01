import { z } from "zod";

import { DIAGRAM_PREVIEW_MODES } from "@/features/algorithms/preview-mode";
import { ALGORITHM_SET_IDS } from "@/features/algorithms/types";

import {
  readStoredValueFromStorage,
  removeStoredValueFromStorage,
  writeStoredValueToStorage,
} from "./local-storage";
import { DRILL_POOL_MODES } from "./pool-storage";
import { CASE_STATUSES } from "./progress-storage";

const DESTINATION = "https://cflop.us";
const OLD_HOST_NAMES = ["cflop.unimatrix-01.dev", "cube.unimatrix-01.dev"] as const;
const OLD_HOSTS = new Set<string>(OLD_HOST_NAMES);
const BRIDGE_PATH = "/origin-migration";
const FRAGMENT_PREFIX = "#cflop-migrate=";
const PROBE_PREFIX = "#cflop-probe=";
const RESULT_PREFIX = "#cflop-probe-result=";
const SKIP_PREFIX = "#cflop-skip=";
const PENDING_KEY = "cflop:origin-migration-pending:v1";
const COMPLETE_KEY = "cflop:origin-migration-complete:v1";
const MAX_PAYLOAD_LENGTH = 32_768;
const SUFFIXES = [
  "progress:oll",
  "progress:pll",
  "pool:oll",
  "pool:pll",
  "pool-mode:oll",
  "pool-mode:pll",
  "preview-mode:learn",
  "preview-mode:drill",
  "algorithm-set",
] as const;

const recordKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/);
const progressSchema = z.record(recordKey, z.enum(CASE_STATUSES));
const poolSchema = z.record(recordKey, z.boolean());
const suffixSchema = z.enum(SUFFIXES);
const payloadSchema = z.strictObject({
  version: z.literal(1),
  hash: z
    .string()
    .max(2048)
    .refine((hash) => hash === "" || hash.startsWith("#")),
  entries: z.array(z.tuple([suffixSchema, z.string().max(8192)])).max(SUFFIXES.length),
});

type MigrationPayload = z.infer<typeof payloadSchema>;
export type MigrationImportResult = "imported" | "existing" | "invalid";

const probeSchema = z.strictObject({
  version: z.literal(1),
  sourceIndex: z.union([z.literal(0), z.literal(1)]),
  nonce: z.uuid(),
  returnHref: z
    .string()
    .max(8192)
    .refine((href) => {
      try {
        return new URL(href).origin === DESTINATION;
      } catch {
        return false;
      }
    }),
});
type MigrationProbe = z.infer<typeof probeSchema>;
const resultSchema = z.strictObject({
  probe: probeSchema,
  payload: payloadSchema,
  skipped: z.literal(true).optional(),
});

function hasStoredData(storage: Storage): boolean {
  return SUFFIXES.some((suffix) => readStoredValueFromStorage(storage, suffix) !== null);
}

function decodeFragment(hash: string, prefix: string): unknown {
  if (!hash.startsWith(prefix) || hash.length > MAX_PAYLOAD_LENGTH * 2) return null;
  try {
    return JSON.parse(decodeURIComponent(hash.slice(prefix.length)));
  } catch {
    return null;
  }
}

function encodeFragment(prefix: string, value: unknown): string {
  const hash = prefix + encodeURIComponent(JSON.stringify(value));
  if (hash.length > MAX_PAYLOAD_LENGTH * 2) throw new Error("Migration data is too large.");
  return hash;
}

function validValue(suffix: string, value: string): boolean {
  if (suffix.startsWith("progress:") || suffix.startsWith("pool:")) {
    try {
      const parsed: unknown = JSON.parse(value);
      return (suffix.startsWith("progress:") ? progressSchema : poolSchema).safeParse(parsed)
        .success;
    } catch {
      return false;
    }
  }
  if (suffix.startsWith("pool-mode:")) return z.enum(DRILL_POOL_MODES).safeParse(value).success;
  if (suffix.startsWith("preview-mode:"))
    return z.enum(DIAGRAM_PREVIEW_MODES).safeParse(value).success;
  return z.enum(ALGORITHM_SET_IDS).safeParse(value).success;
}

function readMigrationPayload(location: URL, storage: Storage): MigrationPayload {
  const entries: MigrationPayload["entries"] = [];
  for (const suffix of SUFFIXES) {
    const value = readStoredValueFromStorage(storage, suffix);
    if (value !== null && value.length <= 8192 && validValue(suffix, value)) {
      entries.push([suffix, value]);
    }
  }
  return payloadSchema.parse({ version: 1, hash: location.hash, entries });
}

export function createMigrationUrl(location: URL, storage: Storage): string {
  // Set the origin separately: a path beginning with // must never choose another host.
  const target = new URL(DESTINATION);
  target.pathname = location.pathname;
  target.search = location.search;
  const payload = readMigrationPayload(location, storage);
  const fragment = FRAGMENT_PREFIX + encodeURIComponent(JSON.stringify(payload));
  if (fragment.length > MAX_PAYLOAD_LENGTH) throw new Error("Migration data is too large.");
  target.hash = payload.entries.length > 0 ? fragment : location.hash;
  return target.href;
}

function parsePayload(hash: string): MigrationPayload | null {
  if (!hash.startsWith(FRAGMENT_PREFIX) || hash.length > MAX_PAYLOAD_LENGTH) return null;
  try {
    const json: unknown = JSON.parse(decodeURIComponent(hash.slice(FRAGMENT_PREFIX.length)));
    const parsed = payloadSchema.safeParse(json);
    if (!parsed.success) return null;
    const { entries } = parsed.data;
    if (new Set(entries.map(([suffix]) => suffix)).size !== entries.length) return null;
    if (!entries.every(([suffix, value]) => validValue(suffix, value))) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function importMigration(hash: string, storage: Storage): MigrationImportResult {
  const payload = parsePayload(hash);
  if (!payload) return "invalid";
  // Even malformed destination values count as existing data; migration must never replace them.
  if (hasStoredData(storage)) return "existing";
  const written: string[] = [];
  try {
    for (const [suffix, value] of payload.entries) {
      writeStoredValueToStorage(storage, suffix, value);
      written.push(suffix);
    }
  } catch (error) {
    for (const suffix of written) removeStoredValueFromStorage(storage, suffix);
    throw error;
  }
  return "imported";
}

function skipUrl(href: string): string {
  const target = new URL(href);
  target.hash = encodeFragment(SKIP_PREFIX, target.hash);
  return target.href;
}

function bridgeUrl(probe: MigrationProbe): string {
  const target = new URL(BRIDGE_PATH, `https://${OLD_HOST_NAMES[probe.sourceIndex]}`);
  target.searchParams.set("attempt", probe.nonce);
  target.hash = encodeFragment(PROBE_PREFIX, probe);
  return target.href;
}

function showMigrationFailure(
  root: HTMLElement,
  continueHref: string,
  onContinue?: () => void,
  retryHref?: string,
): void {
  const panel = document.createElement("main");
  panel.className = "mx-auto flex max-w-xl flex-col gap-4 p-8";
  const title = document.createElement("h1");
  title.className = "text-xl font-semibold";
  title.textContent = "Your saved progress could not be transferred";
  const message = document.createElement("p");
  message.textContent =
    "Allow browser storage and try again. Your original progress is still saved on the old hostname.";
  const retry = document.createElement("button");
  retry.className = "border p-3";
  retry.textContent = "Try again";
  retry.addEventListener("click", () => {
    if (retryHref) window.location.replace(retryHref);
    else window.location.reload();
  });
  const skip = document.createElement("a");
  skip.className = "underline";
  skip.href = skipUrl(continueHref);
  skip.textContent = "Continue without importing";
  if (onContinue && new URL(continueHref).origin === window.location.origin) {
    skip.addEventListener("click", (event) => {
      event.preventDefault();
      window.history.replaceState(window.history.state, "", continueHref);
      onContinue();
    });
  }
  panel.append(title, message, retry, skip);
  root.replaceChildren(panel);
}

function startProbe(returnHref: string, sourceIndex: 0 | 1): void {
  const probe = probeSchema.parse({
    version: 1,
    sourceIndex,
    nonce: crypto.randomUUID(),
    returnHref,
  });
  // Write before navigating: a result without this tab's pending probe is never imported.
  window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(probe));
  window.location.replace(bridgeUrl(probe));
}

function handleBridge(root: HTMLElement, location: URL): void {
  const parsed = probeSchema.safeParse(decodeFragment(location.hash, PROBE_PREFIX));
  if (!parsed.success || OLD_HOST_NAMES[parsed.data.sourceIndex] !== location.hostname) {
    showMigrationFailure(root, DESTINATION);
    return;
  }
  const probe = parsed.data;
  const target = new URL(probe.returnHref);
  try {
    const payload = readMigrationPayload(target, window.localStorage);
    if (
      (FRAGMENT_PREFIX + encodeURIComponent(JSON.stringify(payload))).length > MAX_PAYLOAD_LENGTH
    ) {
      throw new Error("Migration data is too large.");
    }
    // An empty result still acknowledges this source, allowing the next one to be checked.
    target.hash = encodeFragment(RESULT_PREFIX, { probe, payload });
    window.location.replace(target.href);
  } catch {
    const skippedTarget = new URL(probe.returnHref);
    skippedTarget.hash = encodeFragment(RESULT_PREFIX, {
      probe,
      payload: { version: 1, hash: "", entries: [] },
      skipped: true,
    });
    showMigrationFailure(root, probe.returnHref);
    const skip = root.querySelector("a");
    if (skip) skip.href = skippedTarget.href;
  }
}

function cleanLocation(location: URL, hash: string): URL {
  const target = new URL(DESTINATION);
  target.pathname = location.pathname;
  target.search = location.search;
  target.hash = hash;
  return target;
}

function restoreLocation(href: string): void {
  window.history.replaceState(window.history.state, "", href);
}

/** Runs before any component can initialize its state from localStorage. */
export function handleOriginMigration(root: HTMLElement, onContinue?: () => void): boolean {
  const location = new URL(window.location.href);
  if (OLD_HOSTS.has(location.hostname)) {
    if (location.pathname === BRIDGE_PATH) {
      handleBridge(root, location);
      return true;
    }
    try {
      window.location.replace(createMigrationUrl(location, window.localStorage));
    } catch {
      const target = cleanLocation(location, location.hash);
      showMigrationFailure(root, target.href);
    }
    return true;
  }
  if (location.origin !== DESTINATION) return false;
  if (location.hash.startsWith(SKIP_PREFIX)) {
    const hash = decodeFragment(location.hash, SKIP_PREFIX);
    restoreLocation(cleanLocation(location, typeof hash === "string" ? hash : "").href);
    return false;
  }
  let returnHref = location.href;
  let retryHref: string | undefined;
  try {
    if (location.hash.startsWith(FRAGMENT_PREFIX)) {
      const payload = parsePayload(location.hash);
      returnHref = cleanLocation(location, payload?.hash ?? "").href;
      if (!payload) {
        restoreLocation(returnHref);
        return false;
      }
      importMigration(location.hash, window.localStorage);
      restoreLocation(returnHref);
      return false;
    }
    if (location.hash.startsWith(RESULT_PREFIX)) {
      returnHref = cleanLocation(location, "").href;
      const result = resultSchema.safeParse(decodeFragment(location.hash, RESULT_PREFIX));
      const rawPending = window.sessionStorage.getItem(PENDING_KEY);
      const pending = probeSchema.safeParse(rawPending ? JSON.parse(rawPending) : null);
      if (result.success) returnHref = result.data.probe.returnHref;
      if (
        !result.success ||
        !pending.success ||
        JSON.stringify(result.data.probe) !== JSON.stringify(pending.data) ||
        cleanLocation(location, new URL(returnHref).hash).href !== returnHref
      ) {
        throw new Error("Unexpected migration result.");
      }
      retryHref = bridgeUrl(pending.data);
      if (result.data.skipped) {
        window.sessionStorage.removeItem(PENDING_KEY);
        restoreLocation(returnHref);
        return false;
      }
      if (result.data.payload.hash !== new URL(returnHref).hash) {
        throw new Error("Unexpected migration destination.");
      }
      const importResult = importMigration(
        encodeFragment(FRAGMENT_PREFIX, result.data.payload),
        window.localStorage,
      );
      if (importResult === "invalid") throw new Error("Invalid migration data.");
      if (hasStoredData(window.localStorage) || pending.data.sourceIndex === 1) {
        if (!hasStoredData(window.localStorage)) window.localStorage.setItem(COMPLETE_KEY, "1");
        window.sessionStorage.removeItem(PENDING_KEY);
        restoreLocation(returnHref);
        return false;
      }
      startProbe(returnHref, 1);
      return true;
    }
    if (hasStoredData(window.localStorage) || window.localStorage.getItem(COMPLETE_KEY) === "1") {
      return false;
    }
    const rawPending = window.sessionStorage.getItem(PENDING_KEY);
    if (rawPending) {
      let value: unknown;
      try {
        value = JSON.parse(rawPending);
      } catch {
        value = null;
      }
      const pending = probeSchema.safeParse(value);
      if (pending.success) {
        returnHref = pending.data.returnHref;
        retryHref = bridgeUrl(pending.data);
      } else {
        window.sessionStorage.removeItem(PENDING_KEY);
      }
      throw new Error("The previous migration did not finish.");
    }
    // A direct bridge visit on the destination returns to its homepage, never to itself.
    if (location.pathname === BRIDGE_PATH) returnHref = new URL("/", DESTINATION).href;
    startProbe(returnHref, 0);
    return true;
  } catch {
    showMigrationFailure(root, returnHref, onContinue, retryHref);
    return true;
  }
}
