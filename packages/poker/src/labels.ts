import { ocrCategory, pokerOcrContract, validateOcrText } from "./contract.js";

export const POKER_STATUSES = pokerOcrContract.categories.status.values;
export type PokerLabelCategory =
  "name" | "status" | "dealer" | "card" | "money" | "bank" | "pot" | "split" | "game" | "other";

export function labelCategory(regionId: string): PokerLabelCategory {
  const category = ocrCategory(regionId);
  if (!category) return "other";
  if (category === "bet") return "money";
  if (category === "split_pot") return "split";
  if (category === "round_id") return "game";
  return category;
}

const money = /^[GS] \d+(\.\d)? BB$/;
const validators: Record<PokerLabelCategory, { pattern: RegExp; message: string }> = {
  name: {
    pattern: /^[a-zA-Z0-9]+(\.\.\.)?$/,
    message: "Use letters and numbers, optionally followed by three dots.",
  },
  status: {
    pattern: new RegExp(`^(?:${POKER_STATUSES.join("|")})$`),
    message: "Choose a recognized poker action.",
  },
  dealer: { pattern: /^D$/, message: "Dealer labels must be D." },
  card: { pattern: /^(?:A|[2-9]|10|J|Q|K)$/, message: "Use a card rank: A, 2–10, J, Q, or K." },
  money: { pattern: money, message: "Use G 10.5 BB or S 10 BB." },
  bank: { pattern: /^(?:[GS] \d+(\.\d)? BB|All-In)$/, message: "Use an amount in BB or All-In." },
  pot: {
    pattern: /^(?:Pot: [GS] \d+(\.\d)? BB|Run It Twice pause \(\d+ sec\))$/,
    message: "Use Pot: G 10 BB or Run It Twice pause (5 sec).",
  },
  split: {
    pattern: /^(?:[GS] \d+(\.\d)? BB\s*)+$/,
    message: "Use BB amounts separated by spaces.",
  },
  game: { pattern: /^#\s*\d{6,15}$/, message: "Use # followed by 6–15 digits." },
  other: { pattern: /^[\s\S]*$/, message: "" },
};

export function validateLabel(regionId: string, label: string): string | null {
  const category = ocrCategory(regionId);
  if (!category) return "Unsupported OCR region.";
  if (validateOcrText(category, label, true)) return null;
  const validator = validators[labelCategory(regionId)];
  return validator.message || `Invalid ${category} format.`;
}

export function normalizeLabel(regionId: string, input: string): string {
  const text = input.trim().replace(/\s+/g, " ");
  const category = labelCategory(regionId);
  if (category === "card" || category === "dealer") return text.toUpperCase();
  if (category === "status" || category === "bank") {
    const action = [...POKER_STATUSES].find((value) => value.toLowerCase() === text.toLowerCase());
    if (action) return action;
  }
  if (["money", "bank", "pot", "split"].includes(category)) {
    return text
      .replace(/^pot:\s*/i, "Pot: ")
      .replace(/\b[gs]\b/gi, (value) => value.toUpperCase())
      .replace(/\bbb\b/gi, "BB");
  }
  return text;
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
    const withUnit = normalized.replace(/(\d+(?:\.\d)?)(?: B)?$/i, "$1 BB");
    if (withUnit !== normalized && validateLabel(regionId, withUnit) === null) return withUnit;
  }
  return normalized !== input ? normalized : null;
}
