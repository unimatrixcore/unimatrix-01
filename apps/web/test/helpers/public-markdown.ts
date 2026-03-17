import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ReactElement,
  ReactNode,
  createElement as CreateElementFn,
} from "react";
import type { renderToStaticMarkup as RenderToStaticMarkupFn } from "react-dom/server";

export interface PublicMarkdownModule {
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

export interface ReactModules {
  createElement: typeof CreateElementFn;
  renderToStaticMarkup: typeof RenderToStaticMarkupFn;
}

export async function loadPublicMarkdown(): Promise<PublicMarkdownModule> {
  // Tests import the built package entry so they exercise the exported package shape.
  // Run `pnpm --filter @unimatrix/ui build` before these tests if dist is stale or missing.
  const moduleUrl = pathToFileURL(
    join(process.cwd(), "..", "..", "packages", "ui", "dist", "index.js"),
  ).href;

  const publicMarkdownModule: unknown = await import(moduleUrl);

  return publicMarkdownModule as PublicMarkdownModule;
}

export async function loadReactModules(): Promise<ReactModules> {
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

export async function renderMarkdown(markdown: string): Promise<string> {
  const { PublicMarkdown } = await loadPublicMarkdown();
  const { createElement, renderToStaticMarkup } = await loadReactModules();

  return renderToStaticMarkup(
    createElement(PublicMarkdown, {
      markdown,
    }),
  );
}
