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
  const firstParagraph = body
    .split(/\n\n+/u)
    .map((paragraph) =>
      paragraph
        .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
        .replace(/[#>*`_-]/gu, " ")
        .trim(),
    )
    .find((paragraph) => paragraph.length > 0);

  return firstParagraph?.replace(/\s+/gu, " ") ?? "";
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