import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import TurndownService from "turndown";
import { z } from "zod";

export const DOCUMENT_TEXT_LIMITS = {
  maxInputBytes: 262_144,
  maxMarkupMarkers: 4096,
  maxOutputCharacters: 64_000,
  defaultOutputCharacters: 16_000,
  maxConvertedCharacters: 2_000_000,
} as const;

const continuationSchema = z.strictObject({
  documentId: z.string().regex(/^[a-f0-9]{64}$/u),
  offset: z.number().int().positive().max(DOCUMENT_TEXT_LIMITS.maxConvertedCharacters),
});
const requestSchema = z.strictObject({
  html: z.string(),
  baseUrl: z.string().min(1).max(2048),
  maxOutputCharacters: z
    .number()
    .int()
    .min(1)
    .max(DOCUMENT_TEXT_LIMITS.maxOutputCharacters)
    .optional(),
  continuation: continuationSchema.optional(),
});

export type DocumentTextContinuation = z.infer<typeof continuationSchema>;
export type HtmlDocumentRequest = z.infer<typeof requestSchema>;
export interface DocumentTextResult {
  format: "markdown";
  trust: "untrusted";
  text: string;
  source: { url: string; documentId: string; inputBytes: number };
  totalCharacters: number;
  offset: number;
  truncated: boolean;
  continuation: DocumentTextContinuation | null;
}
export type DocumentTextErrorCode =
  | "invalid_input"
  | "input_too_large"
  | "input_too_complex"
  | "conversion_failed"
  | "output_too_large"
  | "invalid_continuation";
export class DocumentTextError extends Error {
  override readonly name = "DocumentTextError";
  constructor(readonly code: DocumentTextErrorCode) {
    super(`Document text conversion failed: ${code}`);
  }
}

function safeUrl(value: string, base?: string): string | null {
  try {
    if (
      Array.from(value).some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      )
    )
      return null;
    const url = new URL(value, base);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href.replace(
      /[()<>"\\|]/gu,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  } catch {
    return null;
  }
}

const excluded = new Set([
  "SCRIPT",
  "STYLE",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "SVG",
  "MATH",
  "TEMPLATE",
  "NOSCRIPT",
  "HEAD",
  "TITLE",
  "META",
  "LINK",
  "BASE",
  "FORM",
  "INPUT",
  "BUTTON",
  "SELECT",
  "TEXTAREA",
  "VIDEO",
  "AUDIO",
  "SOURCE",
  "TRACK",
]);

function isExcluded(node: HTMLElement): boolean {
  return (
    excluded.has(node.nodeName.toUpperCase()) ||
    node.hasAttribute("hidden") ||
    node.getAttribute("aria-hidden") === "true"
  );
}

function visibleCodeText(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeType === 1 && isExcluded(node as HTMLElement)) return "";
  return Array.from(node.childNodes).map(visibleCodeText).join("");
}

function inTableCell(node: HTMLElement): boolean {
  let parent = node.parentElement;
  while (parent) {
    if (parent.nodeName === "TD" || parent.nodeName === "TH") return true;
    parent = parent.parentElement;
  }
  return false;
}

function tableCode(text: string): string {
  return text
    .replace(/\r\n?|\n/gu, " ")
    .split("|")
    .map((part) => {
      if (!part) return "";
      const fence = "`".repeat(
        Math.max(1, ...(part.match(/`+/gu) ?? []).map((run) => run.length + 1)),
      );
      const padding = /^`|^ .*?[^ ].* $|`$/u.test(part) ? " " : "";
      return `${fence}${padding}${part}${padding}${fence}`;
    })
    .join("&#124;");
}

function converter(baseUrl: string): TurndownService {
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  const escape = service.escape.bind(service);
  service.escape = (value) =>
    escape(value).replace(/[&<>|]/gu, (character) => `&#${character.charCodeAt(0)};`);
  let emittedCharacters = 0;
  function bounded(value: string): string {
    emittedCharacters += value.length;
    if (emittedCharacters > DOCUMENT_TEXT_LIMITS.maxConvertedCharacters) {
      throw new DocumentTextError("output_too_large");
    }
    return value;
  }
  service.addRule("links", {
    filter: "a",
    replacement: (content, node) => {
      const target = safeUrl(node.getAttribute("href") ?? "", baseUrl);
      return bounded(target && node.hasAttribute("href") ? `[${content}](${target})` : content);
    },
  });
  service.addRule("images", {
    filter: "img",
    replacement: (_content, node) => bounded(service.escape(node.getAttribute("alt") ?? "")),
  });
  service.addRule("codeBlocks", {
    filter: "pre",
    replacement: (_content, node) => {
      const text = visibleCodeText(node);
      if (inTableCell(node)) return bounded(`\n\n${tableCode(text)}\n\n`);
      const fences = text.match(/`+/gu) ?? [];
      const length = Math.max(3, ...fences.map((fence) => fence.length + 1));
      const fence = "`".repeat(length);
      return bounded(`\n\n${fence}\n${text.replace(/\n$/u, "")}\n${fence}\n\n`);
    },
  });
  service.addRule("tableCode", {
    filter: (node) => node.nodeName === "CODE" && inTableCell(node),
    replacement: (_content, node) => bounded(tableCode(visibleCodeText(node))),
  });
  service.addRule("tableCells", {
    filter: ["th", "td"],
    replacement: (content, node) => {
      const spans = ["colspan", "rowspan"].flatMap((attribute) => {
        const value = node.getAttribute(attribute);
        return value && value !== "1" ? [`${attribute}=${service.escape(value)}`] : [];
      });
      const text = content.trim().replace(/\n+/gu, " ");
      return bounded(` ${text}${spans.length ? ` [${spans.join(", ")}]` : ""} |`);
    },
  });
  service.addRule("tableRows", {
    filter: "tr",
    replacement: (content) => bounded(`\n|${content.trimEnd()}\n`),
  });
  service.addRule("tables", {
    filter: "table",
    replacement: (content, node) => {
      const lines = content
        .trim()
        .split("\n")
        .filter((line) => line.trim());
      const first = lines.findIndex((line) => line.startsWith("|"));
      if (first < 0) return bounded(`\n\n${content.trim()}\n\n`);
      const row = lines[first] ?? "";
      const columns = row.match(/(?<!\\)\|/gu)?.length ?? 2;
      const hasHeader = Boolean(node.querySelector("tr")?.querySelector("th"));
      if (hasHeader) {
        lines.splice(first + 1, 0, `|${" --- |".repeat(columns - 1)}`);
      } else {
        lines.splice(first, 0, `|${" |".repeat(columns - 1)}`, `|${" --- |".repeat(columns - 1)}`);
      }
      if (first > 0) lines.splice(first, 0, "");
      return bounded(`\n\n${lines.join("\n")}\n\n`);
    },
  });
  service.addRule("excluded", {
    filter: isExcluded,
    replacement: () => "",
  });
  return service;
}

export function convertHtmlDocument(input: HtmlDocumentRequest): DocumentTextResult {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new DocumentTextError("invalid_input");
  const request = parsed.data;
  const baseUrl = safeUrl(request.baseUrl);
  if (!baseUrl) throw new DocumentTextError("invalid_input");
  const inputBytes = Buffer.byteLength(request.html, "utf8");
  if (inputBytes > DOCUMENT_TEXT_LIMITS.maxInputBytes)
    throw new DocumentTextError("input_too_large");
  let markupMarkers = 0;
  const markers = request.html.matchAll(/<[!/?a-z]/giu);
  while (!markers.next().done) {
    markupMarkers += 1;
    if (markupMarkers > DOCUMENT_TEXT_LIMITS.maxMarkupMarkers) {
      throw new DocumentTextError("input_too_complex");
    }
  }
  const documentId = createHash("sha256")
    .update(JSON.stringify(["document-text-v2", baseUrl, request.html]))
    .digest("hex");
  if (request.continuation && request.continuation.documentId !== documentId)
    throw new DocumentTextError("invalid_continuation");
  let markdown: string;
  try {
    markdown = converter(baseUrl).turndown(request.html);
  } catch (error) {
    if (error instanceof DocumentTextError) throw error;
    throw new DocumentTextError("conversion_failed");
  }
  if (markdown.length > DOCUMENT_TEXT_LIMITS.maxConvertedCharacters)
    throw new DocumentTextError("output_too_large");
  const characters = Array.from(markdown);
  const offset = request.continuation?.offset ?? 0;
  if (request.continuation && offset >= characters.length)
    throw new DocumentTextError("invalid_continuation");
  const limit = request.maxOutputCharacters ?? DOCUMENT_TEXT_LIMITS.defaultOutputCharacters;
  const text = characters.slice(offset, offset + limit).join("");
  const next = offset + Array.from(text).length;
  const truncated = next < characters.length;
  return {
    format: "markdown",
    trust: "untrusted",
    text,
    source: { url: baseUrl, documentId, inputBytes },
    totalCharacters: characters.length,
    offset,
    truncated,
    continuation: truncated ? { documentId, offset: next } : null,
  };
}
