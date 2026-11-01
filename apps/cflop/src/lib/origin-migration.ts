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
const OLD_HOSTS = new Set(["cflop.unimatrix-01.dev", "cube.unimatrix-01.dev"]);
const FRAGMENT_PREFIX = "#cflop-migrate=";
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

export function createMigrationUrl(location: URL, storage: Storage): string {
  const entries: MigrationPayload["entries"] = [];
  for (const suffix of SUFFIXES) {
    const value = readStoredValueFromStorage(storage, suffix);
    if (value !== null && value.length <= 8192 && validValue(suffix, value)) {
      entries.push([suffix, value]);
    }
  }
  // Set the origin separately: a path beginning with // must never choose another host.
  const target = new URL(DESTINATION);
  target.pathname = location.pathname;
  target.search = location.search;
  const payload = payloadSchema.parse({ version: 1, hash: location.hash, entries });
  const fragment = FRAGMENT_PREFIX + encodeURIComponent(JSON.stringify(payload));
  if (fragment.length > MAX_PAYLOAD_LENGTH) throw new Error("Migration data is too large.");
  target.hash = entries.length > 0 ? fragment : location.hash;
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
  for (const suffix of SUFFIXES) {
    if (readStoredValueFromStorage(storage, suffix) !== null) {
      return "existing";
    }
  }
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

function showMigrationFailure(root: HTMLElement, continueHref: string): void {
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
    window.location.reload();
  });
  const skip = document.createElement("a");
  skip.className = "underline";
  skip.href = continueHref;
  skip.textContent = "Continue without importing";
  if (new URL(continueHref, window.location.href).origin === window.location.origin) {
    skip.addEventListener("click", (event) => {
      event.preventDefault();
      window.history.replaceState(window.history.state, "", continueHref);
      window.location.reload();
    });
  }
  panel.append(title, message, retry, skip);
  root.replaceChildren(panel);
}

/** Runs before any component can initialize its state from localStorage. */
export function handleOriginMigration(root: HTMLElement): boolean {
  const location = new URL(window.location.href);
  if (OLD_HOSTS.has(location.hostname)) {
    try {
      window.location.replace(createMigrationUrl(location, window.localStorage));
    } catch {
      const target = new URL(DESTINATION);
      target.pathname = location.pathname;
      target.search = location.search;
      target.hash = location.hash;
      showMigrationFailure(root, target.href);
    }
    return true;
  }
  if (location.origin !== DESTINATION || !location.hash.startsWith(FRAGMENT_PREFIX)) return false;
  const payload = parsePayload(location.hash);
  const cleanUrl = new URL(DESTINATION);
  cleanUrl.pathname = location.pathname;
  cleanUrl.search = location.search;
  cleanUrl.hash = payload?.hash ?? "";
  const cleanHref = cleanUrl.href;
  if (!payload) {
    window.history.replaceState(window.history.state, "", cleanHref);
    return false;
  }
  try {
    importMigration(location.hash, window.localStorage);
    window.history.replaceState(window.history.state, "", cleanHref);
  } catch {
    showMigrationFailure(root, cleanHref);
    return true;
  }
  return false;
}
