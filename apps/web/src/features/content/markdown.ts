export function splitMarkdownIntoParagraphs(markdown: string): string[] {
  return markdown
    .split(/\n\n+/u)
    .map(normalizeMarkdownParagraph)
    .map((paragraph) => paragraph.replace(/\s+/gu, " "))
    .filter((paragraph) => paragraph.length > 0);
}

function normalizeMarkdownParagraph(paragraph: string): string {
  return paragraph
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^#+\s*/gmu, "")
    .replace(/^\s*(?:[-*+]|[0-9]+\.)\s+/gmu, "")
    .replace(/[>`*_]/gu, "")
    .trim();
}