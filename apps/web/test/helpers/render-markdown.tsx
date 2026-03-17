import type { ReactElement, ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PublicMarkdown } from "@unimatrix/ui/public";

export interface RenderInternalLinkProps {
  children: ReactNode;
  className: string;
  href: string;
}

export function loadReactModules() {
  return {
    createElement,
    renderToStaticMarkup,
  };
}

export function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(<PublicMarkdown markdown={markdown} />);
}

export function renderMarkdownWithInternalLink(
  markdown: string,
  renderInternalLink: (props: RenderInternalLinkProps) => ReactElement,
): string {
  return renderToStaticMarkup(
    <PublicMarkdown
      markdown={markdown}
      renderInternalLink={renderInternalLink}
    />,
  );
}
