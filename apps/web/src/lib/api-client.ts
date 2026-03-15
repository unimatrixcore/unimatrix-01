import { createApiClient } from "@unimatrix/api-client";

import { loadWebRuntimeConfig } from "./config.js";

const runtimeConfig = loadWebRuntimeConfig({
  VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
});

export const apiClient = createApiClient({
  baseUrl: runtimeConfig.apiBaseUrl,
});
