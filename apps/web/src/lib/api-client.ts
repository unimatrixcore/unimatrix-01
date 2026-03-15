import { createApiClient } from "@unimatrix/api-client";

const DEFAULT_API_BASE_URL = "/api";

function resolveApiBaseUrl(): string {
  const envBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();

  if (envBaseUrl) {
    return envBaseUrl;
  }

  return DEFAULT_API_BASE_URL;
}

export const apiClient = createApiClient({
  baseUrl: resolveApiBaseUrl(),
});
