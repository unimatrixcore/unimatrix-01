import { pokerOcrValueContract as contract, isPokerOcrValue } from "@unimatrix/shared";

export const pokerOcrContract = contract;
export const pokerOcrContractSha256 =
  "357e45ae936a3617a34d48b0fe26dd3ea1d5465aecafdfcc5b48badeb4dd6417";
export type PokerOcrCategory = keyof typeof contract.categories;
const rules = contract.region_rules.map((rule) => ({
  category: rule.category,
  pattern: new RegExp(`^(?:${rule.pattern})$`),
}));

export function ocrCategory(regionId: string): PokerOcrCategory | null {
  return rules.find((rule) => rule.pattern.exec(regionId)?.[0] === regionId)?.category ?? null;
}

export function validateOcrText(
  category: PokerOcrCategory,
  text: string,
  allowBlank = false,
): boolean {
  return isPokerOcrValue(category, text, allowBlank);
}

export function validateReviewedLabel(regionId: string, label: string): string | null {
  const category = ocrCategory(regionId);
  if (!category) return "Unsupported OCR region.";
  if (
    category === "status" &&
    new RegExp(`^(?:${contract.categories.status.review_pattern})$`).exec(label)?.[0] === label
  )
    return null;
  return validateOcrText(category, label, true) ? null : `Invalid ${category} format.`;
}
