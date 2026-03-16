import {
  ContentValidationError,
  type ContentValidationIssue,
} from "./errors.js";

export type FrontmatterValue = boolean | string;

export interface FrontmatterDocument {
  body: string;
  frontmatter: Record<string, FrontmatterValue>;
}

const FRONTMATTER_DELIMITER = "---";
const FRONTMATTER_OPENING = `${FRONTMATTER_DELIMITER}\n`;
const FRONTMATTER_CLOSING = `\n${FRONTMATTER_DELIMITER}\n`;

export function parseFrontmatterDocument(
  source: string,
  filePath: string,
): FrontmatterDocument {
  const normalizedSource = source.replace(/\r\n?/gu, "\n");

  if (!normalizedSource.startsWith(FRONTMATTER_OPENING)) {
    throw new ContentValidationError(filePath, [
      {
        field: "frontmatter",
        message: "expected the file to start with a frontmatter block",
      },
    ]);
  }

  const closingIndex = normalizedSource.indexOf(
    FRONTMATTER_CLOSING,
    FRONTMATTER_OPENING.length,
  );

  if (closingIndex === -1) {
    throw new ContentValidationError(filePath, [
      {
        field: "frontmatter",
        message: "expected a closing --- line for the frontmatter block",
      },
    ]);
  }

  const rawFrontmatter = normalizedSource.slice(
    FRONTMATTER_OPENING.length,
    closingIndex,
  );
  const body = normalizedSource
    .slice(closingIndex + FRONTMATTER_CLOSING.length)
    .trim();
  const frontmatter: Record<string, FrontmatterValue> = {};
  const issues: ContentValidationIssue[] = [];

  for (const line of rawFrontmatter.split("\n")) {
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      continue;
    }

    const separatorIndex = line.indexOf(":");

    if (separatorIndex === -1) {
      issues.push({
        field: "frontmatter",
        message: `expected a key:value pair, received "${trimmedLine}"`,
      });
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();

    if (!key) {
      issues.push({
        field: "frontmatter",
        message: `expected a non-empty field name for "${trimmedLine}"`,
      });
      continue;
    }

    frontmatter[key] = parseFrontmatterValue(rawValue);
  }

  if (issues.length > 0) {
    throw new ContentValidationError(filePath, issues);
  }

  return {
    body,
    frontmatter,
  };
}

function parseFrontmatterValue(rawValue: string): FrontmatterValue {
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }

  if (rawValue === "true") {
    return true;
  }

  if (rawValue === "false") {
    return false;
  }

  return rawValue;
}