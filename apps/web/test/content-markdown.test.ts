import assert from "node:assert/strict";
import test from "node:test";

import { splitMarkdownIntoParagraphs } from "../src/features/content/markdown.js";

void test("splitMarkdownIntoParagraphs normalizes heading markers and spacing", () => {
  assert.deepEqual(
    splitMarkdownIntoParagraphs(`# Heading

Paragraph one.

Paragraph   two.`),
    ["Heading", "Paragraph one.", "Paragraph two."],
  );
});