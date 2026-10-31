import type { FastifyError } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

export type DeployHttpErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "INTERNAL_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED";

export interface DeployHttpErrorEnvelope {
  error: {
    code: DeployHttpErrorCode;
    message: string;
  };
}

type DeployHttpLogLevel = "info" | "warn" | "error";

export interface NormalizedDeployHttpError {
  statusCode: number;
  envelope: DeployHttpErrorEnvelope;
  logLevel: DeployHttpLogLevel;
}

function createErrorEnvelope(code: DeployHttpErrorCode, message: string): DeployHttpErrorEnvelope {
  return { error: { code, message } };
}

export function createNotFoundErrorEnvelope(): DeployHttpErrorEnvelope {
  return createErrorEnvelope("NOT_FOUND", "Route not found");
}

export function createAuthErrorEnvelope(status: 401 | 403): DeployHttpErrorEnvelope {
  return status === 401
    ? createErrorEnvelope("UNAUTHORIZED", "Service authentication required")
    : createErrorEnvelope("FORBIDDEN", "Insufficient service capability");
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

  return typeof message === "string" && message.length > 0 ? message : "Request failed";
}

/**
 * Anything unrecognised becomes a bare `INTERNAL_ERROR` with no detail in the body — see
 * `apps/secrets/src/lib/http/errors.ts`'s `normalizeSecretsError`, which this mirrors.
 */
export function normalizeDeployError(error: unknown): NormalizedDeployHttpError {
  if (hasZodFastifySchemaValidationErrors(error)) {
    return {
      statusCode: 400,
      envelope: createErrorEnvelope("VALIDATION_ERROR", "Request validation failed"),
      logLevel: "warn",
    };
  }

  const statusCode = getFastifyStatusCode(error);

  if (statusCode === 429) {
    return {
      statusCode,
      envelope: createErrorEnvelope("RATE_LIMITED", "Too many requests"),
      logLevel: "warn",
    };
  }

  if (statusCode === 404) {
    return { statusCode, envelope: createNotFoundErrorEnvelope(), logLevel: "info" };
  }

  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    return {
      statusCode,
      envelope: createErrorEnvelope("VALIDATION_ERROR", getFastifyErrorMessage(error)),
      logLevel: "warn",
    };
  }

  return {
    statusCode: 500,
    envelope: createErrorEnvelope("INTERNAL_ERROR", "Internal server error"),
    logLevel: "error",
  };
}
