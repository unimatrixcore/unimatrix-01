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

void test("splitMarkdownIntoParagraphs strips safe inline markdown syntax to plain text", () => {
  assert.deepEqual(
    splitMarkdownIntoParagraphs(`- [Read more](https://example.test)

Quoted _note_ with \`inline code\`.`),
    ["Read more", "Quoted note with inline code."],
  );
});