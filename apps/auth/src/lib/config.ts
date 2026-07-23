export interface AuthAppRuntimeConfig {
  apiBaseUrl: string;
  clerkPublishableKey: string;
}

export interface AuthAppDevProxyConfig {
  apiProxyTarget: string;
}

export interface AuthAppRuntimeEnv {
  VITE_API_BASE_URL?: string | undefined;
  VITE_CLERK_PUBLISHABLE_KEY?: string | undefined;
}

export interface AuthAppDevProxyEnv {
  VITE_API_TARGET?: string | undefined;
}

export const DEFAULT_API_BASE_URL = "/api";
export const DEFAULT_API_PROXY_TARGET = "http://127.0.0.1:3001";

function createAuthAppConfigError(message: string): Error {
  return new Error(`Invalid auth app configuration: ${message}`);
}

function readOptionalString(
  variableName: keyof (AuthAppRuntimeEnv & AuthAppDevProxyEnv),
  value: string | undefined,
  fallback: string,
): string {
  if (value === undefined) {
    return fallback;
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw createAuthAppConfigError(`${variableName} must not be empty when it is set.`);
  }

  return trimmedValue;
}

function readRequiredString(
  variableName: keyof AuthAppRuntimeEnv,
  value: string | undefined,
): string {
  if (value === undefined) {
    throw createAuthAppConfigError(`${variableName} is required and was not set.`);
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw createAuthAppConfigError(`${variableName} must not be empty.`);
  }

  return trimmedValue;
}

function validateHttpUrl(
  variableName: keyof (AuthAppRuntimeEnv & AuthAppDevProxyEnv),
  value: string,
): string {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(value);
  } catch {
    throw createAuthAppConfigError(
      `${variableName} must be a valid http:// or https:// URL. Received ${JSON.stringify(value)}.`,
    );
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw createAuthAppConfigError(
      `${variableName} must be a valid http:// or https:// URL. Received ${JSON.stringify(value)}.`,
    );
  }

  return value;
}

function validateApiBaseUrl(value: string | undefined): string {
  const apiBaseUrl = readOptionalString(
    "VITE_API_BASE_URL",
    value,
    DEFAULT_API_BASE_URL,
  );

  if (apiBaseUrl.startsWith("/")) {
    if (apiBaseUrl.startsWith("//")) {
      throw createAuthAppConfigError(
        "VITE_API_BASE_URL must be a site-relative path beginning with a single / or a valid http:// or https:// URL.",
      );
    }

    return apiBaseUrl;
  }

  return validateHttpUrl("VITE_API_BASE_URL", apiBaseUrl);
}

/**
 * Loads and validates browser runtime config for the auth app. Requires
 * `VITE_CLERK_PUBLISHABLE_KEY` — there is no sensible default for a Clerk
 * publishable key, so a missing/empty value throws immediately rather than
 * silently rendering an app with no authentication provider configured.
 */
export function loadAuthAppRuntimeConfig(env: AuthAppRuntimeEnv): AuthAppRuntimeConfig {
  return {
    apiBaseUrl: validateApiBaseUrl(env.VITE_API_BASE_URL),
    clerkPublishableKey: readRequiredString("VITE_CLERK_PUBLISHABLE_KEY", env.VITE_CLERK_PUBLISHABLE_KEY),
  };
}

export function loadAuthAppDevProxyConfig(env: AuthAppDevProxyEnv): AuthAppDevProxyConfig {
  return {
    apiProxyTarget: validateHttpUrl(
      "VITE_API_TARGET",
      readOptionalString("VITE_API_TARGET", env.VITE_API_TARGET, DEFAULT_API_PROXY_TARGET),
    ),
  };
}
