import type {
  BlogEntry,
  BlogFrontmatter,
  HomePageContent,
  HomePageFrontmatter,
  ParsedContentDocument,
  ProjectEntry,
  ProjectFrontmatter,
} from "./documents.js";
import { ContentValidationError } from "./errors.js";
import {
  parseFrontmatterDocument,
  type FrontmatterValue,
} from "./frontmatter.js";

type ContentEntryWithPublishedAt = ParsedContentDocument<{
  publishedAt: string;
}>;

export function parseHomeContentFile(
  source: string,
  filePath: string,
): HomePageContent {
  const { body, frontmatter } = parseFrontmatterDocument(source, filePath);

  return {
    body: requireBody(body, filePath),
    excerpt: deriveExcerpt(body),
    filePath,
    slug: "home",
    frontmatter: {
      intro: requireString(frontmatter, "intro", filePath),
      mission: requireString(frontmatter, "mission", filePath),
      summary: requireString(frontmatter, "summary", filePath),
      title: requireString(frontmatter, "title", filePath),
    } satisfies HomePageFrontmatter,
  };
}

export function parseProjectContentFile(
  source: string,
  filePath: string,
): ProjectEntry {
  const { body, frontmatter } = parseFrontmatterDocument(source, filePath);
  const slug = requireString(frontmatter, "slug", filePath);

  return {
    body: requireBody(body, filePath),
    excerpt: deriveExcerpt(body),
    filePath,
    slug,
    frontmatter: {
      featured: optionalBoolean(frontmatter, "featured") ?? false,
      publishedAt: requireDateString(frontmatter, "publishedAt", filePath),
      slug,
      status: requireString(frontmatter, "status", filePath),
      summary: requireString(frontmatter, "summary", filePath),
      title: requireString(frontmatter, "title", filePath),
      ...optionalProperty("repoUrl", optionalString(frontmatter, "repoUrl")),
    } satisfies ProjectFrontmatter,
  };
}

export function parseBlogContentFile(
  source: string,
  filePath: string,
): BlogEntry {
  const { body, frontmatter } = parseFrontmatterDocument(source, filePath);
  const slug = requireString(frontmatter, "slug", filePath);

  return {
    body: requireBody(body, filePath),
    excerpt: deriveExcerpt(body),
    filePath,
    slug,
    frontmatter: {
      publishedAt: requireDateString(frontmatter, "publishedAt", filePath),
      slug,
      summary: requireString(frontmatter, "summary", filePath),
      title: requireString(frontmatter, "title", filePath),
      ...optionalProperty(
        "description",
        optionalString(frontmatter, "description"),
      ),
    } satisfies BlogFrontmatter,
  };
}

export function sortEntriesByPublishedAtDesc<T extends ContentEntryWithPublishedAt>(
  entries: T[],
): T[] {
  return [...entries].sort(
    (left, right) =>
      new Date(right.frontmatter.publishedAt).getTime() -
      new Date(left.frontmatter.publishedAt).getTime(),
  );
}

function deriveExcerpt(body: string): string {
  const blocks = stripFencedCodeBlocks(body).split(/\n\s*\n+/u);
  let tableFallback: string | undefined;

  for (const block of blocks) {
    const normalizedBlock = normalizeExcerptBlock(block);

    if (normalizedBlock.text.length === 0) {
      continue;
    }

    if (normalizedBlock.kind === "table") {
      tableFallback ??= normalizedBlock.text;
      continue;
    }

    return normalizedBlock.text;
  }

  return tableFallback ?? "";
}

function requireBody(body: string, filePath: string): string {
  if (body.length > 0) {
    return body;
  }

  throw new ContentValidationError(filePath, [
    {
      field: "body",
      message: "expected markdown body content after the frontmatter block",
    },
  ]);
}

function requireDateString(
  frontmatter: Record<string, FrontmatterValue>,
  field: string,
  filePath: string,
): string {
  const value = requireString(frontmatter, field, filePath);

  if (Number.isNaN(Date.parse(value))) {
    throw new ContentValidationError(filePath, [
      {
        field,
        message: `expected a valid date string, received "${value}"`,
      },
    ]);
  }

  return value;
}

function requireString(
  frontmatter: Record<string, FrontmatterValue>,
  field: string,
  filePath: string,
): string {
  const value = frontmatter[field];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ContentValidationError(filePath, [
      {
        field,
        message: "expected a non-empty string",
      },
    ]);
  }

  return value.trim();
}

function optionalString(
  frontmatter: Record<string, FrontmatterValue>,
  field: string,
): string | undefined {
  const value = frontmatter[field];

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : undefined;
}

function optionalBoolean(
  frontmatter: Record<string, FrontmatterValue>,
  field: string,
): boolean | undefined {
  const value = frontmatter[field];
  return typeof value === "boolean" ? value : undefined;
}

function optionalProperty<T extends string, TValue>(
  key: T,
  value: TValue | undefined,
): Partial<Record<T, TValue>> {
  return value === undefined
    ? {}
    : ({ [key]: value } as Partial<Record<T, TValue>>);
}

function stripFencedCodeBlocks(markdown: string): string {
  return markdown.replace(
    /(?:^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*(?=\n|$)/gu,
    "\n",
  );
}

function normalizeExcerptBlock(block: string): {
  kind: "content" | "table";
  text: string;
} {
  const lines = block
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      kind: "content",
      text: "",
    };
  }

  const isTableBlock = lines.some(isTableSeparatorLine);
  const normalizedText = lines
    .filter((line) => !isTableSeparatorLine(line))
    .map(normalizeExcerptLine)
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();

  return {
    kind: isTableBlock ? "table" : "content",
    text: normalizedText,
  };
}

function normalizeExcerptLine(line: string): string {
  let normalizedLine = line.trim();

  if (normalizedLine.length === 0) {
    return "";
  }

  normalizedLine = normalizedLine.replace(/^>+\s*/u, "");

  if (/^#{1,6}\s+/u.test(normalizedLine)) {
    return "";
  }

  if (/^\s*(?:[-*_]\s*){3,}$/u.test(normalizedLine)) {
    return "";
  }

  normalizedLine = normalizedLine.replace(
    /^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/u,
    "",
  );

  if (normalizedLine.includes("|")) {
    normalizedLine = normalizedLine
      .split("|")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
      .join(" ");
  }

  return normalizedLine
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/<\/?[^>]+>/gu, " ")
    .replace(/[*_~]/gu, "")
    .trim();
}

function isTableSeparatorLine(line: string): boolean {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)?$/u.test(line);
}
