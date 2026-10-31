import { createApiClient, type ApiClient } from "@unimatrix/api-client";

import { loadStatusRuntimeConfig } from "./config.js";

const runtimeConfig = loadStatusRuntimeConfig({
  VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
});

/**
 * Tokenless API client for public deployment status.
 */
export const apiClient: ApiClient = createApiClient({
  baseUrl: runtimeConfig.apiBaseUrl,
});
