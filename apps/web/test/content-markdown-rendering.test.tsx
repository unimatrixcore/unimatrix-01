import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import {
  loadReactModules,
  renderMarkdown,
  renderMarkdownWithInternalLink,
} from "./helpers/render-markdown.js";

describe("PublicMarkdown rendering", () => {
  it("renders the supported safe GFM surface", () => {
    const { createElement } = loadReactModules();
    const html = renderMarkdownWithInternalLink(
      `## Console heading

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
      ({
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
    );

    expect(html).toMatch(/<h2/u);
    expect(html).toMatch(/Console heading/u);
    expect(html).toMatch(/<blockquote/u);
    expect(html).toMatch(/<ul/u);
    expect(html).toMatch(/type="checkbox"/u);
    expect(html).toMatch(/<table/u);
    expect(html).toMatch(/data-language="typescript"/u);
    expect(html).toMatch(/href="https:\/\/example\.test"/u);
    expect(html).toMatch(/target="_blank"/u);
    expect(html).toMatch(/data-internal-link="true"/u);
    expect(html).toMatch(/href="\/projects\/unimatrix-01"/u);
    expect(html).toMatch(/src="\/content\/ops-console-topology\.svg"/u);
  });

  it("renders single-line fenced code without a language as block code", () => {
    const html = renderMarkdown(`Before

\`\`\`
const renderer = "safe-gfm";
\`\`\`

After`);

    expect(html).toMatch(/<pre/u);
    expect(html).toMatch(/data-language="plain"/u);
    expect(html).toMatch(/const renderer = &quot;safe-gfm&quot;;/u);
    expect(html).not.toMatch(/border border-border\/60 bg-background\/80/u);
  });
});
