import {
  healthContract,
  type ApiContract,
  type ApiContractResponse,
  type HealthResponse,
} from "@unimatrix/shared";

import type {
  ApiClientConfig,
  ApiClientFetch,
  ApiClientResponse,
} from "./config.js";

export interface ApiClient {
  getHealth(): Promise<HealthResponse>;
  request<TContract extends ApiContract>(
    contract: TContract,
  ): Promise<ApiContractResponse<TContract>>;
}

function buildRequestUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function resolveFetch(fetchImpl?: ApiClientFetch): ApiClientFetch {
  if (fetchImpl) {
    return fetchImpl;
  }

  const globalFetch = (globalThis as { fetch?: ApiClientFetch }).fetch;

  if (!globalFetch) {
    throw new Error("No fetch implementation is available for the API client.");
  }

  return globalFetch.bind(globalThis);
}

async function parseResponse<TContract extends ApiContract>(
  response: ApiClientResponse,
  contract: TContract,
): Promise<ApiContractResponse<TContract>> {
  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new Error(`${contract.method} ${contract.path} returned a non-JSON response.`);
  }

  return contract.responseSchema.parse(payload) as ApiContractResponse<TContract>;
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  const fetchImpl = resolveFetch(config.fetch);
  const headers = {
    accept: "application/json",
    ...config.defaultHeaders,
  } satisfies Record<string, string>;

  const request = async <TContract extends ApiContract>(
    contract: TContract,
  ): Promise<ApiContractResponse<TContract>> => {
    const response = await fetchImpl(buildRequestUrl(config.baseUrl, contract.path), {
      headers,
      method: contract.method,
    });

    if (!response.ok) {
      throw new Error(`${contract.method} ${contract.path} failed with status ${response.status}.`);
    }

    return parseResponse(response, contract);
  };

  return {
    getHealth: () => request(healthContract),
    request,
  };
}
