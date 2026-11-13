import contract from "../ocr-contract.json" with { type: "json" };

export const pokerOcrContract = contract;
export const pokerOcrContractSha256 =
  "199f3970150c4d84e4510e47e91e22556c1fbd07e60b013ceac45055b2bdf7d0";
export type PokerOcrCategory = keyof typeof contract.categories;
const rules = contract.region_rules.map((rule) => ({
  category: rule.category as PokerOcrCategory,
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
  if (text === "" && allowBlank) return true;
  const rule = contract.categories[category];
  return "values" in rule
    ? rule.values.includes(text)
    : new RegExp(`^(?:${rule.pattern})$`).exec(text)?.[0] === text;
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
