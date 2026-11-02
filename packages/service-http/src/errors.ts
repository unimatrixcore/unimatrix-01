export interface ServiceErrorEnvelope<Code extends string, Details = never> {
  error: {
    code: Code;
    message: string;
    statusCode: number;
    details?: Details;
  };
  requestId: string;
}

export interface ServiceErrorEnvelopeOptions<Code extends string, Details = never> {
  requestId: string;
  code: Code;
  message: string;
  statusCode: number;
  details?: Details;
}

// Callers own classification and must supply public-safe messages and details.
export function createErrorEnvelope<Code extends string, Details = never>(
  options: ServiceErrorEnvelopeOptions<Code, Details>,
): ServiceErrorEnvelope<Code, Details> {
  return {
    error: {
      code: options.code,
      message: options.message,
      statusCode: options.statusCode,
      ...(options.details === undefined ? {} : { details: options.details }),
    },
    requestId: options.requestId,
  };
}
