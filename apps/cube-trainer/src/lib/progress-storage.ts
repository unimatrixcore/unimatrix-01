import { z } from "zod";

import type { AlgorithmSetId } from "@/features/algorithms/types";

export const CASE_STATUSES = ["new", "learning", "known"] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];

export type CaseProgress = Record<string, CaseStatus>;

const caseProgressSchema = z.record(z.string(), z.enum(CASE_STATUSES));

function storageKey(setId: AlgorithmSetId): string {
  return `cube-trainer:progress:${setId}`;
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
    // Storage can be unavailable (private browsing, quota). Progress is
    // best-effort and safe to drop silently in that case.
  }
}

export function readCaseProgress(setId: AlgorithmSetId): CaseProgress {
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

  const parsed = caseProgressSchema.safeParse(rawJson);

  return parsed.success ? parsed.data : {};
}

export function writeCaseProgress(setId: AlgorithmSetId, progress: CaseProgress): void {
  writeLocalStorage(storageKey(setId), JSON.stringify(progress));
}

export function setCaseStatus(
  setId: AlgorithmSetId,
  caseId: string,
  status: CaseStatus,
): CaseProgress {
  const next = { ...readCaseProgress(setId), [caseId]: status };

  writeCaseProgress(setId, next);
  return next;
}
