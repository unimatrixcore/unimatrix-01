import { describe, expect, it } from "vitest";

import { renderMarkdown } from "./helpers/render-markdown.js";

describe("PublicMarkdown safety", () => {
  it("suppresses raw HTML instead of rendering it", () => {
    const html = renderMarkdown(`Visible copy.

<div data-raw-html="suppressed">Unsafe raw HTML</div>

<script>alert("x")</script>`);

    expect(html).toMatch(/Visible copy\./u);
    expect(html).not.toMatch(/data-raw-html/u);
    expect(html).not.toMatch(/Unsafe raw HTML/u);
    expect(html).not.toMatch(/<script/u);
  });

  it("sanitizes unsupported link and image protocols", () => {
    const html = renderMarkdown(`[Safe](https://example.test)

[Mail](mailto:gwenny@example.test)

[Blocked](javascript:alert('x'))

![Blocked image](data:image/png;base64,abcd)`);

    expect(html).toMatch(/href="https:\/\/example\.test"/u);
    expect(html).toMatch(/href="mailto:gwenny@example\.test"/u);
    expect(html).toMatch(/target="_blank"/u);
    expect(html).not.toMatch(/javascript:/u);
    expect(html).not.toMatch(/data:image\/png/u);
    expect(html).not.toMatch(/<img/u);
  });
});
