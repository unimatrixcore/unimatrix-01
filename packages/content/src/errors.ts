export interface ContentValidationIssue {
  field: string;
  message: string;
}

function formatIssues(issues: ContentValidationIssue[]): string {
  return issues.map(({ field, message }) => `${field}: ${message}`).join("; ");
}

export class ContentValidationError extends Error {
  readonly filePath: string;
  readonly issues: ContentValidationIssue[];

  constructor(filePath: string, issues: ContentValidationIssue[]) {
    super(`Invalid content in ${filePath}: ${formatIssues(issues)}`);
    this.name = "ContentValidationError";
    this.filePath = filePath;
    this.issues = issues;
  }
}

export function isContentValidationError(
  error: unknown,
): error is ContentValidationError {
  return error instanceof ContentValidationError;
}