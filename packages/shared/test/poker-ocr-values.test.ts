import { describe, expect, it } from "vitest";
import contexts from "./fixtures/poker-ocr-context-values.json" with { type: "json" };
import fixtures from "./fixtures/poker-formatter-values.json" with { type: "json" };
import {
  isPokerOcrValue,
  normalizePokerOcrValue,
  pokerOcrCategoryForRegion,
  pokerOcrValueContract,
  pokerOcrValueSchema,
} from "../src/schemas/poker-ocr-values.js";

describe("source-backed displayed OCR contract", () => {
  it("preserves original field meanings and required visible markers", () => {
    for (const [region, values] of [
      ["round_id", ["#89612405", "# 000001", "#123456789012345"]],
      ["name", ["Player 1", "*RESERVED*", "maxhamme...", "A  B", "Zoë_猫!"]],
      ["bank", ["S 355.6 BB", "G No Chips", "S No Chips", "All-In"]],
      ["bet", ["S 355.6 BB", "G 1,234.12345678 BB"]],
      ["pot", ["Pot: S 31 BB", "Run It Twice pause (12 sec)"]],
      ["split_pot", ["S 235.5 BB S 37.5 BB", "G 2 BB\nS 3 BB"]],
    ] as const)
      for (const value of values)
        expect(pokerOcrValueSchema(region).safeParse(value).success, `${region}:${value}`).toBe(
          true,
        );
    for (const [region, value] of [
      ["bet", "355.6 BB"],
      ["bank", "No Chips"],
      ["pot", "S 31 BB"],
      ["pot", "Pot: 31 BB"],
      ["round_id", "#abc"],
      ["round_id", "#12345"],
      ["round_id", "#1234567890123456"],
      ["round_id", "##123456"],
      ["status", "New Action"],
      ["status", "Call 12.34"],
      ["status", "Winner"],
    ])
      expect(pokerOcrValueSchema(region!).safeParse(value).success, `${region}:${value}`).toBe(
        false,
      );
  });
  it("keeps source formatter samples separate from the rendered currency badge", () => {
    for (const fixture of fixtures.cases) {
      const custom =
        "currencyFormat" in fixture.state
          ? fixture.state.currencyFormat
          : fixture.state.currency === "$"
            ? "${0}"
            : undefined;
      const context = {
        displayInBB: fixture.state.displayInBB,
        grouping: fixture.state.grouping,
        maximumFractionDigits: fixture.state.displayInBB
          ? fixture.state.bbPrecision
          : fixture.state.decimals,
        ...(custom === undefined ? {} : { currencyFormat: custom }),
      };
      const rendered = `S ${fixture.output}`;
      expect(
        pokerOcrValueSchema(fixture.region, context).safeParse(rendered).success,
        JSON.stringify(fixture),
      ).toBe(Number(fixture.value) >= 0);
    }
  });
  it("restricts shortening by role and displayed BB/cash mode", () => {
    for (const region of ["bank", "pot"])
      for (const amount of ["S 1K", "G 1M", "S -1 BB", "S 1K BB"])
        expect(
          pokerOcrValueSchema(region).safeParse(region === "pot" ? `Pot: ${amount}` : amount)
            .success,
        ).toBe(false);
    for (const value of [
      "S -1 BB",
      "S -1K",
      "S 1K BB",
      "S 355.6 B",
      "S 355.6 BE",
      "S 1,23 BB",
      "S 1.123456789 BB",
      "S 1..2 BB",
    ])
      expect(pokerOcrValueSchema("bet").safeParse(value).success, value).toBe(false);
    expect(pokerOcrValueSchema("bet").safeParse("S 1B").success).toBe(false);
    expect(pokerOcrValueSchema("bet", { displayInBB: false }).parse("S 8.88K")).toBe("S 8.88K");
    expect(pokerOcrValueSchema("split_pot", { displayInBB: false }).parse("S 2K G 3M")).toBe(
      "S 2K G 3M",
    );
    expect(pokerOcrValueSchema("pot", { displayInBB: false }).parse("Pot: G 1,234.56")).toBe(
      "Pot: G 1,234.56",
    );
    expect(pokerOcrValueSchema("bet", { displayInBB: true }).safeParse("S 1K").success).toBe(false);
    expect(pokerOcrValueSchema("bet", { displayInBB: false }).safeParse("S 1 BB").success).toBe(
      false,
    );
    expect(pokerOcrValueSchema("bet", { grouping: true }).safeParse("S 1234 BB").success).toBe(
      false,
    );
    expect(pokerOcrValueSchema("bet", { grouping: false }).safeParse("S 1,234 BB").success).toBe(
      false,
    );
    expect(
      pokerOcrValueSchema("bet", { maximumFractionDigits: 2 }).safeParse("S 1.234 BB").success,
    ).toBe(false);
    expect(
      pokerOcrValueSchema("bet", { maximumFractionDigits: 0 }).safeParse("S 1.2 BB").success,
    ).toBe(false);
    expect(
      pokerOcrValueSchema("bet", { maximumFractionDigits: 9 }).safeParse("S 1 BB").success,
    ).toBe(false);
  });
  it("requires explicit custom formatting context without losing its visible badge", () => {
    const options = { currencyFormat: "chips {0} coins", displayInBB: false };
    expect(pokerOcrValueSchema("bet").safeParse("S chips 12.34 coins").success).toBe(false);
    expect(pokerOcrValueSchema("bet", options).parse("S chips 12.34 coins")).toBe(
      "S chips 12.34 coins",
    );
    const repeated = pokerOcrValueSchema("bet", {
      currencyFormat: "{value}/{0}",
      displayInBB: false,
    });
    expect(repeated.safeParse("S 12.34/12.34").success).toBe(true);
    expect(repeated.safeParse("S 12.34/56.78").success).toBe(false);
    expect(
      pokerOcrValueSchema("bet", { currencyFormat: "fixed", displayInBB: false }).parse("S fixed"),
    ).toBe("S fixed");
    expect(
      pokerOcrValueSchema("bank", { currencyFormat: "${0}", displayInBB: false }).safeParse("S $1K")
        .success,
    ).toBe(false);
    expect(
      pokerOcrValueSchema("bet", { currencyFormat: "${0}", displayInBB: true }).parse("S 1 BB"),
    ).toBe("S 1 BB");
  });
  it("normalizes spacing and known casing without inventing characters or identities", () => {
    expect(normalizePokerOcrValue("pot", "Pot:S31BB")).toBe("Pot: S 31 BB");
    expect(normalizePokerOcrValue("bet", "g355.6bb", { legacyCurrencyIcons: true })).toBe(
      "G 355.6 BB",
    );
    expect(normalizePokerOcrValue("split_pot", "S235.5BBG37.5BB")).toBe("S 235.5 BB G 37.5 BB");
    expect(normalizePokerOcrValue("pot", "RunItTwicepause(9sec)")).toBe(
      "Run It Twice pause (9 sec)",
    );
    expect(normalizePokerOcrValue("bank", "all-in")).toBe("All-In");
    expect(normalizePokerOcrValue("bank", "sNoChips")).toBe("S No Chips");
    expect(normalizePokerOcrValue("status", "decline  straddle")).toBe("Decline Straddle");
    expect(normalizePokerOcrValue("name", "maxhamme…")).toBe("maxhamme...");
    expect(normalizePokerOcrValue("name", "A  B")).toBe("A  B");
    expect(pokerOcrValueSchema("pot").safeParse("Pot: Pot: S 31 BB").success).toBe(false);
    expect(pokerOcrValueSchema("bet", { displayInBB: false }).safeParse("S 31B").success).toBe(
      true,
    ); // legitimate cash B, never repaired into BB
    expect(pokerOcrValueSchema("bet", { displayInBB: true }).safeParse("S 31B").success).toBe(
      false,
    );
  });
  it("retains the old pot timer and split list with contextual validation", () => {
    const options = { displayInBB: true, maximumFractionDigits: 2 };
    for (const value of ["All-In", "S No Chips"])
      expect(pokerOcrValueSchema("bank", options).parse(value)).toBe(value);
    expect(pokerOcrValueSchema("pot", options).parse("Run It Twice pause (2 sec)")).toBe(
      "Run It Twice pause (2 sec)",
    );
    expect(pokerOcrValueSchema("pot", options).parse("Pot: S 1.23 BB")).toBe("Pot: S 1.23 BB");
    expect(pokerOcrValueSchema("split_pot", options).parse("S 1 BB G 2 BB")).toBe("S 1 BB G 2 BB");
  });
  it("validates the complete table line with cash-only, unshortened blind values", () => {
    for (const value of [
      "Tigard #17, NLHE - S 0.01/0.02",
      "A, NLHE - G 1,234.12345678/2,345.12345678",
    ])
      expect(pokerOcrValueSchema("table.info").parse(value)).toBe(value);
    for (const value of [
      "A, NLHE - S 1K/2K",
      "A, NLHE - S -1/2",
      "A, NLHE - S 1 BB/2 BB",
      "A, NLHE - 1/2",
    ])
      expect(pokerOcrValueSchema("table.info").safeParse(value).success).toBe(false);
    expect(
      pokerOcrValueSchema("table.info", { currencyFormat: "€{0}", displayInBB: true }).parse(
        "A, NLHE - S €0.01/€0.02",
      ),
    ).toBe("A, NLHE - S €0.01/€0.02");
    expect(
      pokerOcrValueSchema("table.info", { maximumFractionDigits: 9 }).safeParse("A, NLHE - S 1/2")
        .success,
    ).toBe(false);
  });
  it("matches source cash-context fixtures without inferring a mode", () => {
    for (const item of contexts)
      expect(
        pokerOcrValueSchema(item.region, {
          currencyFormat: item.currencyFormat,
          displayInBB: false,
        }).safeParse(item.value).success,
        JSON.stringify(item),
      ).toBe(item.valid);
  });
  it("rejects malformed context and retains contextual legacy-role compatibility", () => {
    expect(
      pokerOcrValueSchema("bet", { maximumFractionDigits: -1 }).safeParse("S 1 BB").success,
    ).toBe(false);
    expect(
      pokerOcrValueSchema("bet", { maximumFractionDigits: 1.5 }).safeParse("S 1 BB").success,
    ).toBe(false);
    expect(
      pokerOcrValueSchema("table.info", { displayInBB: false }).safeParse(", NLHE - S 1/2").success,
    ).toBe(false);
    expect(pokerOcrValueSchema("seat.0.award", { displayInBB: true }).parse("+S 1.23 BB")).toBe(
      "+S 1.23 BB",
    );
    expect(normalizePokerOcrValue("bet", "S12K", { displayInBB: false })).toBe("S 12K");
    expect(
      normalizePokerOcrValue("bet", "S12K", { displayInBB: false, maximumFractionDigits: 9 }),
    ).toBe("S12K");
    expect(normalizePokerOcrValue("pot", "Pot:S12K", { displayInBB: false })).toBe("Pot:S12K");
    expect(normalizePokerOcrValue("split_pot", "S12KG2K", { displayInBB: false })).toBe("S12KG2K");
    expect(normalizePokerOcrValue("unknown", "S12BB")).toBe("S12BB");
  });
  it("keeps all original positional aliases and suit outputs", () => {
    for (const rank of pokerOcrValueContract.categories.card.values)
      expect(pokerOcrValueSchema("community_cards[0]").parse(rank)).toBe(rank);
    expect(pokerOcrValueSchema("community_cards[0]").safeParse("T").success).toBe(false);
    for (const [input, output] of [
      ["♦", "d"],
      ["♥️", "h"],
      ["♣", "c"],
      ["♠", "s"],
      ["D", "d"],
    ])
      expect(pokerOcrValueSchema("seats[8].cards[1].suit").parse(input)).toBe(output);
    expect(pokerOcrValueSchema("dealer").parse("")).toBe("");
    expect(pokerOcrValueSchema("name").safeParse("").success).toBe(false);
    expect(pokerOcrValueSchema("name", { allowBlank: true }).parse("")).toBe("");
    expect(pokerOcrValueSchema("unknown", { allowBlank: true }).safeParse("").success).toBe(false);
    expect(pokerOcrValueSchema("bet").safeParse(12).success).toBe(false);
    expect(pokerOcrCategoryForRegion("seats[0].nameplate")).toBeNull();
    expect(pokerOcrCategoryForRegion("seat.0.timer_bar")).toBeNull();
    expect(isPokerOcrValue("suit", "", true)).toBe(true);
  });
});
