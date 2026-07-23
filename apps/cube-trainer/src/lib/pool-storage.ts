import { z } from "zod";

import type { AlgorithmSetId } from "@/features/algorithms/types";

export type CasePool = Record<string, boolean>;

const casePoolSchema = z.record(z.string(), z.boolean());

function storageKey(setId: AlgorithmSetId): string {
  return `cube-trainer:pool:${setId}`;
}

function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private browsing, quota). The pool is
    // best-effort and safe to drop silently in that case.
  }
}

export function readCasePool(setId: AlgorithmSetId): CasePool {
  const raw = readLocalStorage(storageKey(setId));

  if (raw === null) {
    return {};
  }

  let rawJson: unknown;

  try {
    rawJson = JSON.parse(raw);
  } catch {
    return {};
  }

  const parsed = casePoolSchema.safeParse(rawJson);

  return parsed.success ? parsed.data : {};
}

export function writeCasePool(setId: AlgorithmSetId, pool: CasePool): void {
  writeLocalStorage(storageKey(setId), JSON.stringify(pool));
}

export function setCaseEnabled(setId: AlgorithmSetId, caseId: string, enabled: boolean): CasePool {
  const next = { ...readCasePool(setId), [caseId]: enabled };

  writeCasePool(setId, next);
  return next;
}

/** Cases with no recorded entry are enabled by default (Tim's-style pool: everything on until turned off). */
export function isCaseEnabled(pool: CasePool, caseId: string): boolean {
  return pool[caseId] ?? true;
}
