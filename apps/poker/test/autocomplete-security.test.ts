import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../public/static/js/app.js"), "utf8");
const autocomplete = source.slice(
  source.indexOf("function updateAutocomplete()"),
  source.indexOf("function updateBulkDatalist("),
);

describe("retained autocomplete renderer", () => {
  it("renders typed and suggested markup literally while preserving the Tab hint", () => {
    const typed = '<img src=x onerror="alert(1)">';
    const suggestion = '<svg onload="alert(2)">';
    const ghostText = document.createElement("div");
    const context = {
      document,
      pool: [{ id: "seat.name" }],
      currentReviewIdx: 0,
      labelInput: { value: typed, placeholder: "" },
      ghostText,
      SchemaRegistry: {
        getSchema: () => ({ getSuggestion: () => ({ suggestion, isFuzzy: true }) }),
      },
    };
    runInNewContext(`${autocomplete}\nupdateAutocomplete();`, context);
    expect(ghostText.querySelector("img,svg,script")).toBeNull();
    expect(ghostText.firstElementChild?.firstChild?.textContent).toBe(`\u200b${typed}`);
    expect(ghostText.querySelector(".suggestion-part")?.firstChild?.textContent).toBe(
      ` > ${suggestion}`,
    );
    expect(ghostText.querySelector(".kbd")?.textContent).toBe("TAB");
  });
});
