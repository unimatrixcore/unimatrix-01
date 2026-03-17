import assert from "node:assert/strict";
import test from "node:test";
import type { ReactNode } from "react";

import {
  loadPublicMarkdown,
  loadReactModules,
  renderMarkdown,
} from "./helpers/public-markdown.js";

void test("PublicMarkdown renders the supported safe GFM surface", async () => {
  const { PublicMarkdown } = await loadPublicMarkdown();
  const { createElement, renderToStaticMarkup } = await loadReactModules();
  const html = renderToStaticMarkup(
    createElement(PublicMarkdown, {
      markdown: `## Console heading

> Blockquote signal.

- Archive item
- [x] Ship safe GFM

| Surface | Mode |
| --- | --- |
| Public site | Safe GFM |

\`\`\`ts
const renderer = "safe-gfm";
\`\`\`

[External](https://example.test)

[Internal](/projects/unimatrix-01)

![Topology](/content/ops-console-topology.svg)`,
      renderInternalLink: ({
        children,
        className,
        href,
      }: {
        children: ReactNode;
        className: string;
        href: string;
      }) =>
        createElement(
          "a",
          {
            className,
            "data-internal-link": "true",
            href,
          },
          children,
        ),
    }),
  );

  assert.match(html, /<h2/u);
  assert.match(html, /Console heading/u);
  assert.match(html, /<blockquote/u);
  assert.match(html, /<ul/u);
  assert.match(html, /type="checkbox"/u);
  assert.match(html, /<table/u);
  assert.match(html, /data-language="typescript"/u);
  assert.match(html, /href="https:\/\/example\.test"/u);
  assert.match(html, /target="_blank"/u);
  assert.match(html, /data-internal-link="true"/u);
  assert.match(html, /href="\/projects\/unimatrix-01"/u);
  assert.match(html, /src="\/content\/ops-console-topology\.svg"/u);
});

void test("PublicMarkdown renders single-line fenced code without a language as block code", async () => {
  const html = await renderMarkdown(`Before

\`\`\`
const renderer = "safe-gfm";
\`\`\`

After`);

  assert.match(html, /<pre/u);
  assert.match(html, /data-language="plain"/u);
  assert.match(html, /const renderer = &quot;safe-gfm&quot;;/u);
  assert.doesNotMatch(html, /border border-border\/60 bg-background\/80/u);
});
