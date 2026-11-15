import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pokerOcrValueContract, normalizePokerOcrValue, isPokerOcrValue } from "@unimatrix/shared";
import { pokerOcrContract, validateOcrText } from "../src/contract.js";

const fixturePath = new URL(
  "../../shared/test/fixtures/poker-ocr-normalization.json",
  import.meta.url,
);
const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  region: string;
  category: keyof typeof pokerOcrValueContract.categories;
  input: string;
  output: string;
  valid: boolean;
  legacyCurrencyIcons?: boolean;
  currencyFormat?: string;
}[];

describe("one generated source-derived OCR contract", () => {
  it("keeps generated native/Python bytes equal to shared metadata", () => {
    expect(pokerOcrContract).toEqual(pokerOcrValueContract);
    const generated = JSON.stringify(pokerOcrValueContract, null, 2) + "\n";
    expect(readFileSync(new URL("../ocr-contract.json", import.meta.url), "utf8")).toBe(generated);
    expect(
      readFileSync(
        new URL("../../../tools/poker/dev_tools/ocr_contract.json", import.meta.url),
        "utf8",
      ),
    ).toBe(generated);
  });
  it("uses identical shared/Poker normalization and validation fixtures", () => {
    for (const item of cases) {
      const normalized = normalizePokerOcrValue(item.region, item.input, {
        legacyCurrencyIcons: item.legacyCurrencyIcons === true,
        ...(item.currencyFormat === undefined ? {} : { currencyFormat: item.currencyFormat }),
      });
      expect(normalized).toBe(item.output);
      expect(isPokerOcrValue(item.category, normalized)).toBe(item.valid);
      expect(validateOcrText(item.category, normalized)).toBe(item.valid);
    }
  });
  it("matches the Python adapter on the same fixtures", () => {
    const script =
      "import sys,json;sys.path.insert(0,sys.argv[1]);from ocr_contract import normalize_region_text,validate_text;cases=json.load(open(sys.argv[2]));print(json.dumps([[normalize_region_text(c['region'],c['category'],c['input'],c.get('legacyCurrencyIcons',False),c.get('currencyFormat')),validate_text(c['category'],normalize_region_text(c['region'],c['category'],c['input'],c.get('legacyCurrencyIcons',False),c.get('currencyFormat')))] for c in cases],ensure_ascii=False))";
    const result = spawnSync(
      "python",
      [
        "-c",
        script,
        new URL("../../../tools/poker/dev_tools/lib", import.meta.url).pathname,
        fixturePath.pathname,
      ],
      { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(cases.map((item) => [item.output, item.valid]));
  });
  it("matches the Python explicit cash-context adapter", () => {
    const contextsPath = new URL(
      "../../shared/test/fixtures/poker-ocr-context-values.json",
      import.meta.url,
    );
    const contexts = JSON.parse(readFileSync(contextsPath, "utf8")) as { valid: boolean }[];
    const script =
      "import sys,json;sys.path.insert(0,sys.argv[1]);from ocr_contract import validate_text_with_currency_format;cases=json.load(open(sys.argv[2]));print(json.dumps([validate_text_with_currency_format(c['category'],c['value'],False,c['currencyFormat']) for c in cases]))";
    const result = spawnSync(
      "python",
      [
        "-c",
        script,
        new URL("../../../tools/poker/dev_tools/lib", import.meta.url).pathname,
        contextsPath.pathname,
      ],
      { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(contexts.map((item) => item.valid));
  });
});
