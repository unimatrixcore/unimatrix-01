export interface WebRuntimeConfig {
  apiBaseUrl: string;
}

export interface WebDevProxyConfig {
  apiProxyTarget: string;
}

export interface WebRuntimeEnv {
  VITE_API_BASE_URL?: string | undefined;
}

export interface WebDevProxyEnv {
  VITE_API_TARGET?: string | undefined;
}

export const DEFAULT_API_BASE_URL = "/api";
export const DEFAULT_API_PROXY_TARGET = "http://127.0.0.1:3001";

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
    return apiBaseUrl;
  }

  return validateHttpUrl("VITE_API_BASE_URL", apiBaseUrl);
}

export function loadWebRuntimeConfig(env: WebRuntimeEnv): WebRuntimeConfig {
  return {
    apiBaseUrl: validateApiBaseUrl(env.VITE_API_BASE_URL),
  };
}

export function loadWebDevProxyConfig(
  env: WebDevProxyEnv = process.env,
): WebDevProxyConfig {
  return {
    apiProxyTarget: validateHttpUrl(
      "VITE_API_TARGET",
      readOptionalString("VITE_API_TARGET", env.VITE_API_TARGET, DEFAULT_API_PROXY_TARGET),
    ),
  };
}