const errors = {
  CREDENTIAL_DENIED: [503, "Canvas credential access was denied."],
  CREDENTIAL_MISSING: [503, "Canvas integration credential is missing or inaccessible."],
  CREDENTIAL_UNAVAILABLE: [503, "Canvas credential store is unavailable."],
  CANVAS_ACCOUNT_MISMATCH: [409, "Canvas credential belongs to a different account."],
  CANVAS_CREDENTIAL_REJECTED: [502, "Canvas rejected the integration credential."],
  CANVAS_UNAVAILABLE: [502, "Canvas is unavailable."],
  CANVAS_INVALID_RESPONSE: [502, "Canvas returned an invalid response."],
  CANVAS_REQUEST_FAILED: [502, "Canvas request failed."],
  CANVAS_UNSAFE_PAGINATION: [502, "Canvas returned unsafe pagination."],
  CANVAS_RESOURCE_UNAVAILABLE: [502, "Canvas resource is inaccessible."],
  CANVAS_BUDGET_EXHAUSTED: [503, "Canvas request budget was exhausted."],
  CANVAS_INVALID_CURSOR: [409, "Canvas continuation is invalid or expired."],
  REQUEST_CANCELLED: [503, "Canvas operation was cancelled."],
} as const;

export type CanvasConnectionErrorCode = keyof typeof errors;

export class CanvasConnectionError extends Error {
  readonly code: CanvasConnectionErrorCode;
  readonly statusCode: 409 | 502 | 503;

  constructor(code: CanvasConnectionErrorCode) {
    super(errors[code][1]);
    this.name = "CanvasConnectionError";
    this.code = code;
    this.statusCode = errors[code][0];
  }
}
