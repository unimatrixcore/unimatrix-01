import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown } from "./helpers/public-markdown.js";

void test("PublicMarkdown suppresses raw HTML instead of rendering it", async () => {
  const html = await renderMarkdown(`Visible copy.

<div data-raw-html="suppressed">Unsafe raw HTML</div>

<script>alert("x")</script>`);

  assert.match(html, /Visible copy\./u);
  assert.doesNotMatch(html, /data-raw-html/u);
  assert.doesNotMatch(html, /Unsafe raw HTML/u);
  assert.doesNotMatch(html, /<script/u);
});

void test("PublicMarkdown sanitizes unsupported link and image protocols", async () => {
  const html = await renderMarkdown(`[Safe](https://example.test)

[Mail](mailto:gwenny@example.test)

[Blocked](javascript:alert('x'))

![Blocked image](data:image/png;base64,abcd)`);

  assert.match(html, /href="https:\/\/example\.test"/u);
  assert.match(html, /href="mailto:gwenny@example\.test"/u);
  assert.match(html, /target="_blank"/u);
  assert.doesNotMatch(html, /javascript:/u);
  assert.doesNotMatch(html, /data:image\/png/u);
  assert.doesNotMatch(html, /<img/u);
});
