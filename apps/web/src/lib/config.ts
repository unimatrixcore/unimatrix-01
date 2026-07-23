export interface WebRuntimeConfig {
  apiBaseUrl: string;
  authAppUrl: string;
  clerkPublishableKey?: string;
}

export interface WebDevProxyConfig {
  apiProxyTarget: string;
}

export interface WebRuntimeEnv {
  VITE_API_BASE_URL?: string | undefined;
  VITE_AUTH_APP_URL?: string | undefined;
  VITE_CLERK_PUBLISHABLE_KEY?: string | undefined;
}

export interface WebDevProxyEnv {
  VITE_API_TARGET?: string | undefined;
}

export const DEFAULT_API_BASE_URL = "/api";
export const DEFAULT_API_PROXY_TARGET = "http://127.0.0.1:3001";
export const DEFAULT_AUTH_APP_URL = "https://auth.unimatrix-01.dev";

function createWebConfigError(message: string): Error {
  return new Error(`Invalid web configuration: ${message}`);
}

function readOptionalString(
  variableName: keyof (WebRuntimeEnv & WebDevProxyEnv),
  value: string | undefined,
  fallback: string,
): string {
  if (value === undefined) {
    return fallback;
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw createWebConfigError(`${variableName} must not be empty when it is set.`);
  }

  return trimmedValue;
}

/**
 * Like {@link readOptionalString} but with no fallback: an unset value stays
 * `undefined` (the feature it configures is simply disabled), while a value
 * that is present but blank is still rejected.
 */
function readOptionalStringWithoutFallback(
  variableName: keyof (WebRuntimeEnv & WebDevProxyEnv),
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw createWebConfigError(`${variableName} must not be empty when it is set.`);
  }

  return trimmedValue;
}

function validateHttpUrl(
  variableName: keyof (WebRuntimeEnv & WebDevProxyEnv),
  value: string,
): string {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(value);
  } catch {
    throw createWebConfigError(
      `${variableName} must be a valid http:// or https:// URL. Received ${JSON.stringify(value)}.`,
    );
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw createWebConfigError(
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
      throw createWebConfigError(
        "VITE_API_BASE_URL must be a site-relative path beginning with a single / or a valid http:// or https:// URL.",
      );
    }

    return apiBaseUrl;
  }

  return validateHttpUrl("VITE_API_BASE_URL", apiBaseUrl);
}

function validateAuthAppUrl(value: string | undefined): string {
  return validateHttpUrl(
    "VITE_AUTH_APP_URL",
    readOptionalString("VITE_AUTH_APP_URL", value, DEFAULT_AUTH_APP_URL),
  );
}

/**
 * Clerk is entirely optional for `apps/web` (a public portfolio site): when
 * `VITE_CLERK_PUBLISHABLE_KEY` is unset, `undefined` is returned and the app
 * renders exactly as it does with no auth provider configured at all. When
 * set, it must be non-empty once trimmed.
 */
function validateClerkPublishableKey(value: string | undefined): string | undefined {
  return readOptionalStringWithoutFallback("VITE_CLERK_PUBLISHABLE_KEY", value);
}

export function loadWebRuntimeConfig(env: WebRuntimeEnv): WebRuntimeConfig {
  const clerkPublishableKey = validateClerkPublishableKey(env.VITE_CLERK_PUBLISHABLE_KEY);

  return {
    apiBaseUrl: validateApiBaseUrl(env.VITE_API_BASE_URL),
    authAppUrl: validateAuthAppUrl(env.VITE_AUTH_APP_URL),
    ...(clerkPublishableKey !== undefined ? { clerkPublishableKey } : {}),
  };
}

export function loadWebDevProxyConfig(env: WebDevProxyEnv): WebDevProxyConfig {
  return {
    apiProxyTarget: validateHttpUrl(
      "VITE_API_TARGET",
      readOptionalString("VITE_API_TARGET", env.VITE_API_TARGET, DEFAULT_API_PROXY_TARGET),
    ),
  };
}

/**
 * Whether Clerk-backed auth is enabled for this build. Narrows
 * `clerkPublishableKey` to `string` so callers can branch on this once
 * instead of re-checking `!== undefined` at every call site.
 */
export function isAuthEnabled(
  config: WebRuntimeConfig,
): config is WebRuntimeConfig & { clerkPublishableKey: string } {
  return config.clerkPublishableKey !== undefined;
}
