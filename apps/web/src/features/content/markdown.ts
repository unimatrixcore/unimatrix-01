export function splitMarkdownIntoParagraphs(markdown: string): string[] {
  return markdown
    .split(/\n\n+/u)
    .map((paragraph) => paragraph.replace(/^#+\s*/u, "").trim())
    .map((paragraph) => paragraph.replace(/\s+/gu, " "))
    .filter((paragraph) => paragraph.length > 0);
}