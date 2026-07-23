import { AuthError } from "@unimatrix/auth/server";
import type { FastifyError } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "CLIENT_ERROR"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INTERNAL_ERROR";

export interface ApiValidationIssue {
  path: string;
  message: string;
  code: string;
}

export interface ApiErrorDetails {
  issues?: ApiValidationIssue[];
}

export interface ApiErrorEnvelope {
  error: {
    code: ApiErrorCode;
    message: string;
    statusCode: number;
    details?: ApiErrorDetails;
  };
  requestId: string;
}

interface ApiErrorOptions {
  statusCode: number;
  code: ApiErrorCode;
  message: string;
  details?: ApiErrorDetails;
  cause?: unknown;
}

type ApiErrorLogLevel = "info" | "warn" | "error";

export interface NormalizedApiError {
  statusCode: number;
  envelope: ApiErrorEnvelope;
  logLevel: ApiErrorLogLevel;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly details?: ApiErrorDetails;

  constructor(options: ApiErrorOptions) {
    super(
      options.message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );

    this.name = "ApiError";
    this.statusCode = options.statusCode;
    this.code = options.code;

    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

interface ApiErrorEnvelopeOptions {
  requestId: string;
  code: ApiErrorCode;
  message: string;
  statusCode: number;
  details?: ApiErrorDetails;
}

export function createApiErrorEnvelope(
  options: ApiErrorEnvelopeOptions,
): ApiErrorEnvelope {
  const error: ApiErrorEnvelope["error"] = {
    code: options.code,
    message: options.message,
    statusCode: options.statusCode,
  };

  if (hasApiErrorDetails(options.details)) {
    error.details = options.details;
  }

  return {
    error,
    requestId: options.requestId,
  };
}

export function createNotFoundErrorEnvelope(requestId: string): ApiErrorEnvelope {
  return createApiErrorEnvelope({
    requestId,
    code: "NOT_FOUND",
    message: "Route not found",
    statusCode: 404,
  });
}

function createClientErrorEnvelope(
  requestId: string,
  statusCode: number,
  message: string,
): ApiErrorEnvelope {
  return createApiErrorEnvelope({
    requestId,
    code: "CLIENT_ERROR",
    message,
    statusCode,
  });
}

export function normalizeError(
  error: unknown,
  requestId: string,
): NormalizedApiError {
  if (hasZodFastifySchemaValidationErrors(error)) {
    return {
      statusCode: 400,
      envelope: createApiErrorEnvelope({
        requestId,
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        statusCode: 400,
        details: {
          issues: normalizeValidationIssues(error.validation),
        },
      }),
      logLevel: "warn",
    };
  }

  if (error instanceof ApiError) {
    const envelopeOptions: ApiErrorEnvelopeOptions = {
      requestId,
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
    };

    if (error.details !== undefined) {
      envelopeOptions.details = error.details;
    }

    return {
      statusCode: error.statusCode,
      envelope: createApiErrorEnvelope(envelopeOptions),
      logLevel: getLogLevelForStatusCode(error.statusCode),
    };
  }

  if (error instanceof AuthError) {
    return {
      statusCode: error.statusCode,
      envelope: createApiErrorEnvelope({
        requestId,
        code: error.code,
        message: error.message,
        statusCode: error.statusCode,
      }),
      logLevel: "warn",
    };
  }

  const fastifyStatusCode = getFastifyStatusCode(error);

  if (fastifyStatusCode === 404) {
    return {
      statusCode: 404,
      envelope: createNotFoundErrorEnvelope(requestId),
      logLevel: "info",
    };
  }

  if (isClientErrorStatusCode(fastifyStatusCode)) {
    return {
      statusCode: fastifyStatusCode,
      envelope: createClientErrorEnvelope(
        requestId,
        fastifyStatusCode,
        getFastifyErrorMessage(error),
      ),
      logLevel: "warn",
    };
  }

  return {
    statusCode: 500,
    envelope: createInternalErrorEnvelope(requestId),
    logLevel: "error",
  };
}

function createInternalErrorEnvelope(requestId: string): ApiErrorEnvelope {
  return createApiErrorEnvelope({
    requestId,
    code: "INTERNAL_ERROR",
    message: "Internal server error",
    statusCode: 500,
  });
}

function normalizeValidationIssues(
  issues: ReadonlyArray<{
    instancePath: string;
    keyword: string;
    message?: string;
  }>,
): ApiValidationIssue[] {
  return issues.map((issue) => ({
    path: normalizeInstancePath(issue.instancePath),
    message: issue.message ?? "Invalid request input",
    code: issue.keyword,
  }));
}

function normalizeInstancePath(instancePath: string): string {
  if (instancePath === "" || instancePath === "/") {
    return "$";
  }

  return instancePath
    .split("/")
    .filter(Boolean)
    .map(decodeJsonPointerSegment)
    .join(".");
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function hasApiErrorDetails(
  details: ApiErrorDetails | undefined,
): details is ApiErrorDetails {
  return Boolean(details?.issues?.length);
}

function getFastifyStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }

  const { statusCode } = error as FastifyError;

  return typeof statusCode === "number" ? statusCode : undefined;
}

function getFastifyErrorMessage(error: unknown): string {
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return "Request failed";
  }

  const { message } = error as FastifyError;

  return typeof message === "string" && message.length > 0
    ? message
    : "Request failed";
}

function isClientErrorStatusCode(
  statusCode: number | undefined,
): statusCode is number {
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500;
}

function getLogLevelForStatusCode(statusCode: number): ApiErrorLogLevel {
  if (statusCode >= 500) {
    return "error";
  }

  if (statusCode === 404) {
    return "info";
  }

  return "warn";
}
