import {
  apiBaseUrl,
  envSchema,
  loadDevProxyConfig,
  parseAppEnv,
  type DevProxyConfig,
  type DevProxyEnv,
} from "@unimatrix/app-config";

export interface StatusRuntimeConfig {
  apiBaseUrl: string;
}

export interface StatusRuntimeEnv {
  VITE_API_BASE_URL?: string | undefined;
}

export type StatusDevProxyConfig = DevProxyConfig;
export type StatusDevProxyEnv = DevProxyEnv;

const runtimeEnvSchema = envSchema({
  VITE_API_BASE_URL: apiBaseUrl(),
});

export function loadStatusRuntimeConfig(env: StatusRuntimeEnv): StatusRuntimeConfig {
  const parsed = parseAppEnv("status", runtimeEnvSchema, env);

  return {
    apiBaseUrl: parsed.VITE_API_BASE_URL,
  };
}

export function loadStatusDevProxyConfig(env: StatusDevProxyEnv): StatusDevProxyConfig {
  return loadDevProxyConfig("status", env);
}
