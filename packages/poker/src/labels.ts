import { normalizePokerOcrValue, type PokerOcrValueOptions } from "@unimatrix/shared";
import {
  ocrCategory,
  pokerOcrContract,
  validateOcrText,
  type PokerOcrCategory,
} from "./contract.js";

export const POKER_STATUSES = pokerOcrContract.categories.status.values;
export type PokerLabelCategory = PokerOcrCategory | "money" | "split" | "game" | "other";

export function labelCategory(regionId: string): PokerLabelCategory {
  const category = ocrCategory(regionId);
  if (!category) return "other";
  if (category === "bet") return "money";
  if (category === "split_pot") return "split";
  if (category === "round_id") return "game";
  return category;
}

const messages: Partial<Record<PokerLabelCategory, string>> = {
  card: "Use a card rank: A, 2–10, J, Q, or K.",
  suit: "Use a suit: d, h, c, or s.",
  dealer: "Dealer labels must be D.",
};

export function validateLabel(regionId: string, label: string): string | null {
  const category = ocrCategory(regionId);
  if (!category) return "Unsupported OCR region.";
  if (validateOcrText(category, label, true)) return null;
  return messages[labelCategory(regionId)] || `Invalid ${category} format.`;
}

export function normalizeLabel(
  regionId: string,
  input: string,
  options: PokerOcrValueOptions = {},
): string {
  return normalizePokerOcrValue(regionId, input, options);
}

const shorthands: Record<string, string> = {
  k: "Check",
  c: "Call",
  r: "Raise",
  b: "Bet",
  ai: "All-In",
  ds: "Decline Straddle",
  hw: "Hide Winning",
  sc: "Show Cards",
  st: "Straddle",
  sb: "SB",
  bb: "BB",
};

function subsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const char of haystack) if (char === needle[index]) index += 1;
  return index === needle.length;
}

export function completeLabel(
  regionId: string,
  input: string,
  knownLabels: readonly string[] = [],
): string | null {
  if (!input.trim()) return null;
  const category = labelCategory(regionId);
  const normalized = normalizeLabel(regionId, input);
  const lower = normalized.toLowerCase();
  if (category === "status" && shorthands[lower]) return shorthands[lower] ?? null;
  if (category === "card" && normalized === "1") return "10";
  if (category === "name" && /^[a-zA-Z0-9]+\.{1,2}$/.test(normalized))
    return normalized.replace(/\.+$/, "...");
  const candidates =
    category === "status"
      ? [...POKER_STATUSES]
      : category === "name"
        ? knownLabels.filter((value) => validateLabel(regionId, value) === null && value !== "")
        : category === "bank"
          ? ["All-In"]
          : [];
  const match =
    candidates.find((value) => value.toLowerCase().startsWith(lower)) ??
    (lower.length >= 2
      ? candidates.find((value) => subsequence(lower, value.toLowerCase()))
      : undefined);
  if (match && match !== input) return match;
  if (["money", "bank", "pot", "split"].includes(category)) {
    const withUnit = normalized.replace(/(^| )(\d+(?:\.\d{1,8})?) B$/i, "$1$2 BB");
    if (withUnit !== normalized && validateLabel(regionId, withUnit) === null) return withUnit;
  }
  return normalized !== input ? normalized : null;
}
