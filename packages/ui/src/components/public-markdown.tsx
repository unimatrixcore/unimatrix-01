import * as React from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Highlight,
  Prism,
  type PrismTheme,
} from "prism-react-renderer";

import { cn } from "../lib/utils.js";

const opsConsoleCodeTheme: PrismTheme = {
  plain: {
    backgroundColor: "transparent",
    color: "oklch(0.92 0.03 190)",
  },
  styles: [
    {
      types: ["comment", "prolog", "doctype", "cdata"],
      style: {
        color: "oklch(0.64 0.03 210)",
        fontStyle: "italic",
      },
    },
    {
      types: ["punctuation", "operator"],
      style: {
        color: "oklch(0.8 0.02 210)",
      },
    },
    {
      types: ["property", "attr-name", "tag", "keyword", "selector"],
      style: {
        color: "oklch(0.78 0.14 168)",
      },
    },
    {
      types: ["string", "char", "attr-value", "inserted"],
      style: {
        color: "oklch(0.86 0.13 134)",
      },
    },
    {
      types: ["number", "constant", "builtin", "boolean"],
      style: {
        color: "oklch(0.83 0.15 72)",
      },
    },
    {
      types: ["function", "class-name"],
      style: {
        color: "oklch(0.84 0.08 225)",
      },
    },
    {
      types: ["variable", "parameter"],
      style: {
        color: "oklch(0.9 0.02 220)",
      },
    },
  ],
};

export interface PublicMarkdownProps {
  className?: string;
  markdown: string;
  renderInternalLink?: (props: {
    href: string;
    children: React.ReactNode;
    className: string;
  }) => React.ReactElement;
}

type SanitizedLink =
  | {
      href: string;
      kind: "external" | "hash" | "internal" | "mailto";
    }
  | undefined;

const markdownLinkClassName =
  "font-medium text-foreground underline decoration-border underline-offset-[0.28em] transition-colors hover:text-primary hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

export function PublicMarkdown({
  className,
  markdown,
  renderInternalLink,
}: PublicMarkdownProps) {
  const components: Components = {
    a({ children, className: linkClassName, href, node, ...props }) {
      void node;
      const safeLink = sanitizeMarkdownLink(href);
      const resolvedClassName = cn(markdownLinkClassName, linkClassName);

      if (!safeLink) {
        return (
          <span
            className={cn(
              "text-muted-foreground underline decoration-dotted underline-offset-[0.28em]",
              linkClassName,
            )}
          >
            {children}
          </span>
        );
      }

      if (safeLink.kind === "internal" && renderInternalLink) {
        return renderInternalLink({
          children,
          className: resolvedClassName,
          href: safeLink.href,
        });
      }

      return (
        <a
          {...props}
          className={resolvedClassName}
          href={safeLink.href}
          rel={
            safeLink.kind === "external" || safeLink.kind === "mailto"
              ? "noreferrer"
              : props.rel
          }
          target={
            safeLink.kind === "external" || safeLink.kind === "mailto"
              ? "_blank"
              : props.target
          }
        >
          {children}
        </a>
      );
    },
    code({ children, className: codeClassName, node, ...props }) {
      const rawCode = childrenToString(children);
      const isBlockCode = isMarkdownCodeBlock({
        className: codeClassName,
        node,
        rawCode,
      });

      if (isBlockCode) {
        return (
          <code {...props} className={codeClassName}>
            {children}
          </code>
        );
      }

      return (
        <code
          {...props}
          className={cn(
            "border border-border/60 bg-background/80 px-1.5 py-0.5 text-[0.88em] text-foreground",
            codeClassName,
          )}
        >
          {children}
        </code>
      );
    },
    img({ alt, className: imageClassName, node, src, ...props }) {
      void node;
      const safeSource = sanitizeMarkdownImageSource(src);

      if (!safeSource) {
        return alt ? (
          <span className="text-sm text-muted-foreground">{alt}</span>
        ) : null;
      }

      return (
        <img
          {...props}
          alt={alt ?? ""}
          className={cn(
            "my-8 block w-full border border-border/70 bg-background/45 object-cover shadow-[0_24px_80px_-52px_color-mix(in_oklab,var(--foreground)_75%,transparent)]",
            imageClassName,
          )}
          loading="lazy"
          src={safeSource}
        />
      );
    },
    input({ checked, className: inputClassName, node, type, ...props }) {
      void node;
      if (type === "checkbox") {
        return (
          <input
            {...props}
            checked={checked}
            className={cn(
              "mr-3 inline-flex size-3.5 border border-border/70 bg-background align-middle accent-primary",
              inputClassName,
            )}
            disabled
            readOnly
            type="checkbox"
          />
        );
      }

      return <input {...props} className={inputClassName} type={type} />;
    },
    pre({ children, className: preClassName, node }) {
      void node;
      const codeBlock = extractCodeBlock(children);

      if (!codeBlock) {
        return (
          <pre
            className={cn(
              "my-6 overflow-x-auto border border-border/70 bg-background/45 p-4 text-sm text-foreground",
              preClassName,
            )}
          >
            {children}
          </pre>
        );
      }

      return (
        <HighlightedCodeBlock
          code={codeBlock.code}
          {...(preClassName ? { className: preClassName } : {})}
          {...(codeBlock.language ? { language: codeBlock.language } : {})}
        />
      );
    },
    table({ children, className: tableClassName, node, ...props }) {
      void node;
      return (
        <div className="my-8 overflow-x-auto border border-border/70 bg-background/40">
          <table {...props} className={cn("min-w-full text-left text-sm", tableClassName)}>
            {children}
          </table>
        </div>
      );
    },
  };

  return (
    <div className={cn("public-markdown", className)} data-slot="public-markdown">
      <Markdown
        components={components}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={sanitizeMarkdownNodeUrl}
      >
        {markdown}
      </Markdown>
    </div>
  );
}

function HighlightedCodeBlock({
  className,
  code,
  language,
}: {
  className?: string | undefined;
  code: string;
  language?: string | undefined;
}) {
  const resolvedLanguage = language && hasPrismLanguage(language) ? language : undefined;

  if (!resolvedLanguage) {
    return (
      <pre
        className={cn(
          "my-8 overflow-x-auto border border-border/70 bg-[color-mix(in_oklab,var(--background)_88%,black)] px-4 py-4 text-sm text-foreground shadow-[0_28px_90px_-58px_color-mix(in_oklab,var(--foreground)_75%,transparent)]",
          className,
        )}
        data-language="plain"
      >
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <Highlight
      code={code}
      language={resolvedLanguage}
      prism={Prism}
      theme={opsConsoleCodeTheme}
    >
      {({ className: highlightClassName, getLineProps, getTokenProps, style, tokens }) => (
        <pre
          className={cn(
            "my-8 overflow-x-auto border border-border/70 bg-[color-mix(in_oklab,var(--background)_88%,black)] px-4 py-4 text-sm shadow-[0_28px_90px_-58px_color-mix(in_oklab,var(--foreground)_75%,transparent)]",
            highlightClassName,
            className,
          )}
          data-language={resolvedLanguage}
          style={style}
        >
          <code className="grid min-w-fit gap-1">
            {tokens.map((line, index) => (
              <div
                key={`${resolvedLanguage}:${index}`}
                {...getLineProps({ line })}
                className="grid min-w-fit grid-cols-[2.5rem_minmax(0,1fr)] gap-3"
              >
                <span className="select-none text-right text-[0.72rem] text-muted-foreground/75">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="min-w-fit">
                  {line.length === 0 ? (
                    <span>&nbsp;</span>
                  ) : (
                    line.map((token, tokenIndex) => (
                      <span
                        key={`${resolvedLanguage}:${index}:${tokenIndex}`}
                        {...getTokenProps({ token })}
                      />
                    ))
                  )}
                </span>
              </div>
            ))}
          </code>
        </pre>
      )}
    </Highlight>
  );
}

function extractCodeBlock(children: React.ReactNode): {
  code: string;
  language?: string | undefined;
} | undefined {
  const childNodes = React.Children.toArray(children);

  if (childNodes.length !== 1) {
    return undefined;
  }

  const onlyChild = childNodes[0];

  if (!React.isValidElement<{
    children?: React.ReactNode;
    className?: string;
  }>(onlyChild)) {
    return undefined;
  }

  const codeProps = onlyChild.props;
  const rawCode = childrenToString(codeProps.children).replace(/\n$/u, "");
  const language = resolveCodeLanguage(codeProps.className);

  return {
    code: rawCode,
    ...(language ? { language } : {}),
  };
}

function childrenToString(children: React.ReactNode): string {
  return React.Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }

      if (React.isValidElement<{ children?: React.ReactNode }>(child)) {
        return childrenToString(child.props.children);
      }

      return "";
    })
    .join("");
}

function resolveCodeLanguage(className?: string): string | undefined {
  const languageMatch = className?.match(/language-([a-z0-9-]+)/iu);
  const language = languageMatch?.[1]?.toLowerCase();

  if (!language) {
    return undefined;
  }

  switch (language) {
    case "js":
      return "javascript";
    case "md":
      return "markdown";
    case "sh":
    case "shell":
      return "bash";
    case "ts":
      return "typescript";
    case "yml":
      return "yaml";
    default:
      return language;
  }
}

function isMarkdownCodeBlock({
  className,
  node,
  rawCode,
}: {
  className: string | undefined;
  node: unknown;
  rawCode: string;
}): boolean {
  if (resolveCodeLanguage(className)) {
    return true;
  }

  if (rawCode.includes("\n")) {
    return true;
  }

  const codeNode = node as
    | {
        position?: {
          end?: { line?: number } | undefined;
          start?: { column?: number; line?: number } | undefined;
        } | undefined;
      }
    | undefined;
  const startLine = codeNode?.position?.start?.line;
  const endLine = codeNode?.position?.end?.line;

  return Boolean(
    startLine &&
      endLine &&
      endLine > startLine &&
      codeNode?.position?.start?.column === 1,
  );
}

function hasPrismLanguage(language: string): boolean {
  return Object.hasOwn(Prism.languages, language);
}

function sanitizeMarkdownNodeUrl(url: string, key: string): string {
  if (key === "href") {
    return sanitizeMarkdownLink(url)?.href ?? "";
  }

  if (key === "src") {
    return sanitizeMarkdownImageSource(url) ?? "";
  }

  return url;
}

function sanitizeMarkdownLink(url: string | undefined | null): SanitizedLink {
  const normalizedUrl = normalizeUrl(url);

  if (!normalizedUrl) {
    return undefined;
  }

  if (normalizedUrl.startsWith("#")) {
    return {
      href: normalizedUrl,
      kind: "hash",
    };
  }

  if (normalizedUrl.startsWith("/") && !normalizedUrl.startsWith("//")) {
    return {
      href: normalizedUrl,
      kind: "internal",
    };
  }

  if (/^mailto:/iu.test(normalizedUrl)) {
    return {
      href: normalizedUrl,
      kind: "mailto",
    };
  }

  if (/^https?:/iu.test(normalizedUrl)) {
    return {
      href: normalizedUrl,
      kind: "external",
    };
  }

  return undefined;
}

function sanitizeMarkdownImageSource(
  url: string | undefined | null,
): string | undefined {
  const normalizedUrl = normalizeUrl(url);

  if (!normalizedUrl) {
    return undefined;
  }

  if (normalizedUrl.startsWith("/") && !normalizedUrl.startsWith("//")) {
    return normalizedUrl;
  }

  return /^https?:/iu.test(normalizedUrl) ? normalizedUrl : undefined;
}

function normalizeUrl(url: string | undefined | null): string | undefined {
  const trimmedUrl = url?.trim();
  return trimmedUrl && trimmedUrl.length > 0 ? trimmedUrl : undefined;
}
