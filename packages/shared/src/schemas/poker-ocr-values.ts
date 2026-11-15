import { z } from "zod";

const text = "[\\s\\S]*";
const integer = "(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)";
const decimal = `${integer}(?:\\.[0-9]{1,8})?`;
const cash = decimal;
const plainAmount = `[GS] ${decimal} BB`;
const shortAmount = `[GS] ${decimal} BB`;
const amount = shortAmount;
const award = `\\+?${shortAmount}`;
const partialAmount = "[GS] ?[0-9,]*(?:\\.[0-9]{0,8})?(?: ?B{0,2}|[KMBTQP]?)";
const pause = "Run It Twice pause \\([0-9]+ sec\\)";

export const pokerOcrValueContract = {
  version: 5,
  format: {
    locale: "en-US",
    maximum_fraction_digits: 8,
    short_suffixes: ["K", "M", "B", "T", "Q", "P"],
    custom_currency_requires_context: true,
    number_pattern: decimal,
    cash_pattern: cash,
    amount_pattern: amount,
    short_cash_categories: ["bet", "split_pot", "amount"],
  },
  normalization: {
    decorative_currency_prefixes: [],
    region_display_prefixes: [],
    suit_aliases: { "♦": "d", "♥": "h", "♣": "c", "♠": "s" },
    rank_aliases: {},
    amount_tokens: "([GS])([0-9][0-9,]*(?:\\.[0-9]{1,8})?(?:BB|[KMBTQP])?|NoChips)",
    pause_tokens: "RunItTwicepause\\(([0-9]+)sec\\)",
  },
  categories: {
    name: { pattern: "\\S(?:[^\\r\\n]*\\S)?" },
    status: {
      review_pattern: "(?=[A-Za-z -]*[A-Za-z])[A-Za-z -]{1,64}",
      values_exhaustive: true,
      values: [
        "Call",
        "Fold",
        "BB",
        "Raise",
        "Check",
        "Decline Straddle",
        "SB",
        "Hide Winning",
        "Hide Cards",
        "All-In",
        "Bet",
        "Show Cards",
        "Straddle",
        "Away",
        "Ante",
        "Muck",
        "Sit out",
        "Time",
        "Disconnected",
      ],
    },
    winner: { values: ["Winner"] },
    card: { values: ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] },
    suit: { values: ["d", "h", "c", "s"] },
    dealer: { values: ["D", ""] },
    bank: {
      pattern: `(?:${plainAmount}|[GS] No Chips|All-In)`,
      partial_pattern: partialAmount,
      partial_values: ["All-In", "S No Chips", "G No Chips"],
    },
    bet: { pattern: amount, partial_pattern: partialAmount },
    amount: { pattern: `(?:${award}|(?:All-In|No Chips))`, partial_pattern: partialAmount },
    pot: {
      pattern: `(?:Pot: ${plainAmount}|${pause})`,
      partial_pattern: `(?:Pot: ?${partialAmount}|Run It Twice pause \\([0-9]*(?: s(?:e(?:c\\)?)?)?)?)`,
      partial_values: ["Pot:", "Run It Twice pause ("],
    },
    split_pot: {
      pattern: `${amount}(?:[ \\t\\r\\n\\f\\v]+${amount})*`,
      partial_pattern: `(?:${amount} +)*${partialAmount}`,
    },
    round_id: { pattern: "#[ \\t\\r\\n\\f\\v]*[0-9]{6,15}" },
    table_info: { pattern: `\\S[^\\r\\n]*, NLHE - [GS] ${cash}/${cash}` },
    timer: { pattern: "(?:0|[1-9][0-9]*|[1-9](?:\\.[0-9]+)?e\\+[0-9]+)" },
    popup: { pattern: text },
    combination: { pattern: text },
  },
  region_rules: [
    { category: "pot", pattern: "pot\\.total" },
    {
      category: "winner",
      pattern: "seat\\.[0-8]\\.winner",
    },
    {
      category: "status",
      pattern: "seat\\.[0-8]\\.(?:action|status)",
    },
    {
      category: "round_id",
      pattern: "game\\.id",
    },
    {
      category: "card",
      pattern: "(?:board\\.[0-4]|seat\\.[0-8]\\.card\\.[0-5])\\.rank",
    },
    {
      category: "suit",
      pattern:
        "(?:board\\.[0-4]|seat\\.[0-8]\\.card\\.[0-5]|community_cards\\[[0-4]\\]|seats\\[[0-8]\\]\\.cards\\[[01]\\])\\.suit",
    },
    {
      category: "table_info",
      pattern: "table\\.info",
    },
    {
      category: "amount",
      pattern: "(?:seat\\.[0-8]\\.award|pot\\.[0-9])",
    },
    {
      category: "timer",
      pattern: "(?:seat\\.[0-8]\\.timer|header\\.timer)",
    },
    {
      category: "popup",
      pattern: "(?:seat\\.[0-8]\\.popup|game\\.high_hand)",
    },
    {
      category: "combination",
      pattern: "seat\\.[0-8]\\.combination",
    },
    {
      category: "dealer",
      pattern: "dealer",
    },
    {
      category: "round_id",
      pattern: "round_id",
    },
    {
      category: "name",
      pattern: "(?:(?:seat|seats)(?:\\[[0-9]+\\]|\\.[0-9]+)?\\.)?name",
    },
    {
      category: "status",
      pattern: "(?:(?:seat|seats)(?:\\[[0-9]+\\]|\\.[0-9]+)?\\.)?status",
    },
    {
      category: "dealer",
      pattern: "(?:(?:seat|seats)(?:\\[[0-9]+\\]|\\.[0-9]+)?\\.)?dealer",
    },
    {
      category: "bank",
      pattern: "(?:(?:seat|seats)(?:\\[[0-9]+\\]|\\.[0-9]+)?\\.)?bank",
    },
    {
      category: "bet",
      pattern: "(?:(?:seat|seats)(?:\\[[0-9]+\\]|\\.[0-9]+)?\\.)?bet",
    },
    {
      category: "split_pot",
      pattern: "(?:split_pot(?:\\[[1-9]\\])?|pot\\.split)",
    },
    {
      category: "pot",
      pattern: "(?:pot(?:\\.main)?|main_pot)",
    },
    {
      category: "card",
      pattern:
        "(?:community_cards(?:\\[[0-9]+\\])+|community(?:\\[[0-9]+\\])*|community\\.card_[0-9]+|(?:(?:seat|seats)(?:\\[[0-9]+\\]|\\.[0-9]+)?\\.)?(?:cards(?:\\[[0-9]+\\])*|hand(?:_[0-9]+|(?:\\[[0-9]+\\])*)?))",
    },
  ],
} as const;

export type PokerOcrValueCategory = keyof typeof pokerOcrValueContract.categories;
export type PokerSuitValue = "d" | "h" | "c" | "s";
export interface PokerOcrValueOptions {
  allowBlank?: boolean;
  currencyFormat?: string;
  displayInBB?: boolean;
  maximumFractionDigits?: number;
  grouping?: boolean;
  legacyCurrencyIcons?: boolean;
}

type ValueRule =
  { pattern: string; values?: undefined } | { values: readonly string[]; pattern?: undefined };

const exact = (pattern: string) => new RegExp(`^(?:${pattern})$`);
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function pokerOcrCategoryForRegion(regionId: string): PokerOcrValueCategory | null {
  return (
    pokerOcrValueContract.region_rules.find(
      (rule) => exact(rule.pattern).exec(regionId)?.[0] === regionId,
    )?.category ?? null
  );
}

export function normalizePokerOcrValue(
  regionId: string,
  input: string,
  options: PokerOcrValueOptions = {},
): string {
  const category = pokerOcrCategoryForRegion(regionId);
  let value = input.trim();
  if (category === "suit") {
    const glyph = value.replace(/[\ufe0e\ufe0f]/g, "");
    return (
      pokerOcrValueContract.normalization.suit_aliases[
        glyph as keyof typeof pokerOcrValueContract.normalization.suit_aliases
      ] ?? glyph.toLowerCase()
    );
  }
  if (category === "card" || category === "dealer") return value.toUpperCase();
  if (category === "status")
    return (
      pokerOcrValueContract.categories.status.values.find(
        (v) => v.toLowerCase() === value.replace(/\s+/g, " ").toLowerCase(),
      ) ?? value
    );
  if (category === "name") return value.replace(/…/g, "...");
  if (["winner", "popup", "combination", "round_id"].includes(category ?? "")) return value;
  if (options.currencyFormat !== undefined) return value;
  value = value.replace(/\s+/g, " ").replace(/\bbb\b/gi, "BB");
  if (category === "table_info") return value;
  const compact = value.replace(/\s/g, "");
  const timer =
    category === "pot"
      ? new RegExp(`^${pokerOcrValueContract.normalization.pause_tokens}$`, "i").exec(compact)
      : null;
  if (timer) return `Run It Twice pause (${timer[1]} sec)`;
  if (category === "bank" && /^all-in$/i.test(compact)) return "All-In";
  const prefix = category === "pot" && /^Pot:/i.test(compact) ? "Pot: " : "";
  const body = prefix ? compact.slice(4) : compact;
  const parts = [
    ...body.matchAll(new RegExp(pokerOcrValueContract.normalization.amount_tokens, "gi")),
  ];
  if (parts.length && parts.map((p) => p[0]).join("") === body) {
    const formatted =
      prefix +
      parts
        .map(
          (p) =>
            `${p[1]!.toUpperCase()} ${/^NoChips$/i.test(p[2]!) ? "No Chips" : p[2]!.toUpperCase().replace(/BB$/, " BB")}`,
        )
        .join(" ");
    if (
      category &&
      (isPokerOcrValue(category, formatted) ||
        (options.displayInBB === false &&
          category !== "pot" &&
          category !== "split_pot" &&
          exact(contextAmountPattern(options, category) ?? "(?!)").test(formatted)))
    )
      return formatted;
  }
  return value;
}

export function isPokerOcrValue(
  category: PokerOcrValueCategory,
  value: string,
  allowBlank = false,
): boolean {
  if (value === "" && allowBlank) return true;
  const rule: ValueRule = pokerOcrValueContract.categories[category];
  return rule.values ? rule.values.includes(value) : exact(rule.pattern).exec(value)?.[0] === value;
}

function contextAmountPattern(
  options: PokerOcrValueOptions,
  category: PokerOcrValueCategory,
  captureName = "amount",
  marker = true,
): string | null {
  const digits = options.maximumFractionDigits ?? 8;
  if (!Number.isInteger(digits) || digits < 0 || digits > 8) return null;
  const whole =
    options.grouping === true
      ? "(?:0|[1-9][0-9]{0,2}(?:,[0-9]{3})*)"
      : options.grouping === false
        ? "(?:0|[1-9][0-9]*)"
        : integer;
  const number = `${whole}${digits ? `(?:\\.[0-9]{1,${digits}})?` : ""}`;
  const shortened = ["bet", "split_pot", "amount"].includes(category) ? "[KMBTQP]?" : "";
  const numericCash = `${number}${shortened}`;
  const prefix = marker ? "[GS] " : "";
  if (options.displayInBB === true) return `${prefix}${number} BB`;
  if (options.currencyFormat === undefined)
    return `${prefix}(?:${options.displayInBB === false ? "" : `${number} BB|`}${numericCash})`;
  const template = options.currencyFormat;
  const tokens = ["{0}", "{value}"]
    .map((token) => ({ token, index: template.indexOf(token) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index);
  let result = "",
    offset = 0;
  for (const [index, item] of tokens.entries()) {
    result +=
      escape(template.slice(offset, item.index)) +
      (index === 0 ? `(?<${captureName}>${numericCash})` : `\\k<${captureName}>`);
    offset = item.index + item.token.length;
  }
  return prefix + result + escape(template.slice(offset));
}

export function pokerOcrValueSchema(
  regionId: string,
  options: PokerOcrValueOptions = {},
): z.ZodType<string> {
  const category = pokerOcrCategoryForRegion(regionId);
  return z.preprocess(
    (value) =>
      typeof value === "string" ? normalizePokerOcrValue(regionId, value, options) : value,
    z.string().superRefine((value, ctx) => {
      if (!category) {
        ctx.addIssue({ code: "custom", message: "Unsupported OCR region." });
        return;
      }
      if (value === "") {
        if (options.allowBlank !== true && category !== "dealer")
          ctx.addIssue({ code: "custom", message: "Mark an empty reading explicitly as blank." });
        return;
      }
      const monetary = ["bet", "amount", "bank", "pot", "split_pot"].includes(category);
      const contextGiven =
        options.currencyFormat !== undefined ||
        options.displayInBB !== undefined ||
        options.maximumFractionDigits !== undefined ||
        options.grouping !== undefined;
      let pattern = monetary && contextGiven ? contextAmountPattern(options, category) : null;
      if (pattern && regionId.endsWith(".award")) pattern = `\\+${pattern}`;
      if (pattern && category === "bank") pattern = `(?:${pattern}|All-In|[GS] No Chips)`;
      if (pattern && category === "pot") pattern = `(?:Pot: ${pattern}|${pause})`;
      if (pattern && category === "split_pot") pattern = `(?:${pattern}[ \\t\\r\\n\\f\\v]*)+`;
      if (category === "table_info" && contextGiven) {
        const small = contextAmountPattern(
          { ...options, displayInBB: false },
          "table_info",
          "small",
        );
        const big = contextAmountPattern(
          { ...options, displayInBB: false },
          "table_info",
          "big",
          false,
        );
        pattern = small && big ? `\\S[^\\r\\n]*, NLHE - ${small}/${big}` : null;
      }
      const contextual = contextGiven && (monetary || category === "table_info");
      const tablePrefixFits =
        category !== "table_info" || value.slice(0, value.lastIndexOf(", NLHE")).trim().length > 0;
      const valid =
        tablePrefixFits &&
        (contextual
          ? !!pattern && exact(pattern).exec(value)?.[0] === value
          : isPokerOcrValue(category, value, false));
      if (!valid)
        ctx.addIssue({
          code: "custom",
          message: `Invalid ${category} value for the source formatter/profile.`,
        });
    }),
  );
}

export const pokerRankValueSchema = pokerOcrValueSchema("board.0.rank");
export const pokerSuitValueSchema = pokerOcrValueSchema("board.0.suit");
