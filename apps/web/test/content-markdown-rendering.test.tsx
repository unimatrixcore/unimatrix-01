import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type {
  ReactElement,
  ReactNode,
  createElement as CreateElementFn,
} from "react";
import type { renderToStaticMarkup as RenderToStaticMarkupFn } from "react-dom/server";

interface PublicMarkdownModule {
  PublicMarkdown: (props: {
    markdown: string;
    className?: string | undefined;
    renderInternalLink?: ((props: {
      href: string;
      children: ReactNode;
      className: string;
    }) => ReactElement) | undefined;
  }) => ReactElement;
}

interface ReactModules {
  createElement: typeof CreateElementFn;
  renderToStaticMarkup: typeof RenderToStaticMarkupFn;
}

async function loadPublicMarkdown() {
  const moduleUrl = pathToFileURL(
    join(process.cwd(), "..", "..", "packages", "ui", "dist", "index.js"),
  ).href;

  const publicMarkdownModule: unknown = await import(moduleUrl);

  return publicMarkdownModule as PublicMarkdownModule;
}

async function loadReactModules(): Promise<ReactModules> {
  const rootRequire = createRequire(join(process.cwd(), "package.json"));
  const reactModule: unknown = await import(
    pathToFileURL(rootRequire.resolve("react")).href,
  );
  const reactDomServerModule: unknown = await import(
    pathToFileURL(rootRequire.resolve("react-dom/server")).href,
  );

  return {
    createElement: (reactModule as { createElement: typeof CreateElementFn }).createElement,
    renderToStaticMarkup: (
      reactDomServerModule as { renderToStaticMarkup: typeof RenderToStaticMarkupFn }
    ).renderToStaticMarkup,
  };
}

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
