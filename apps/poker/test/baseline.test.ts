import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import baseline from "../migration-baseline.json";

describe("Poker Lab migration fidelity", () => {
  it("retains the original controller, scoring, completion, watch and CSS bytes", () => {
    for (const artifact of baseline.preserved.filter((value) => value.mode === "preserved")) {
      const bytes = readFileSync(resolve(import.meta.dirname, "..", artifact.target));
      expect(createHash("sha256").update(bytes).digest("hex"), artifact.target).toBe(
        artifact.sha256,
      );
    }
  });
  it("retains original element identities and removes server templating only", () => {
    const html = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");
    for (const id of [
      "nav-collection",
      "nav-labeling",
      "nav-session-review",
      "nav-database",
      "dataset-select",
      "capture-once",
      "watch-start",
      "label-input",
      "model-accept",
      "ai-review-panel",
      "db-pagination",
    ])
      expect(html).toContain(`id="${id}"`);
    expect(html).toContain("/static/ui/poker-chip.svg");
    expect(html).not.toMatch(/\{%|\{\{/);
    expect(html).not.toContain("Mark blank");
    expect(html).not.toContain("/regions");
  });
});
