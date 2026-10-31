import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import {
  deployHealthHistoryContract,
  deployStateContract,
  type ApiContract,
  type ApiContractResponse,
  type DeployHealthHistoryResponse,
  type DeployStateResponse,
} from "@unimatrix/shared";

export interface DeployClientConfig {
  baseUrl: string;
  serviceToken: string;
  caCertificatePem?: string;
  timeoutMs?: number;
}

export interface DeployClient {
  getState(): Promise<DeployStateResponse>;
  getHealth(app: string): Promise<DeployHealthHistoryResponse>;
}

export class DeployClientError extends Error {
  constructor() {
    super("Deployment read unavailable");
    this.name = "DeployClientError";
  }
}

const MAX_RESPONSE_BYTES = 1_048_576;

export function createDeployClient(config: DeployClientConfig): DeployClient {
  let origin: URL;
  try {
    origin = new URL(config.baseUrl);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username !== "" ||
      origin.password !== "" ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.hash !== "" ||
      config.serviceToken.trim() === "" ||
      /[\r\n]/u.test(config.serviceToken) ||
      (origin.protocol === "https:" && !config.caCertificatePem) ||
      (origin.protocol === "http:" && config.caCertificatePem !== undefined)
    ) {
      throw new DeployClientError();
    }
  } catch {
    throw new DeployClientError();
  }
  const timeoutMs = config.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new DeployClientError();

  async function read<TContract extends ApiContract>(
    contract: TContract,
    query: Record<string, string>,
  ): Promise<ApiContractResponse<TContract>> {
    try {
      const parsedQuery: unknown = contract.querySchema?.parse(query);
      const url = new URL(contract.path, origin);
      for (const [key, value] of Object.entries(parsedQuery as Record<string, string>)) {
        url.searchParams.set(key, value);
      }
      const body = await new Promise<string>((resolve, reject) => {
        const request = origin.protocol === "https:" ? httpsRequest : httpRequest;
        const req = request(
          url,
          {
            agent: false,
            method: contract.method,
            headers: { accept: "application/json", authorization: `Bearer ${config.serviceToken}` },
            ...(origin.protocol === "https:" ? { ca: config.caCertificatePem } : {}),
          },
          (response) => {
            if (response.statusCode !== 200) {
              response.destroy();
              reject(new DeployClientError());
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > MAX_RESPONSE_BYTES) {
                response.destroy();
                reject(new DeployClientError());
              } else {
                chunks.push(chunk);
              }
            });
            response.on("error", () => {
              reject(new DeployClientError());
            });
            response.on("end", () => {
              resolve(Buffer.concat(chunks).toString("utf8"));
            });
          },
        );
        const deadline = setTimeout(() => req.destroy(new DeployClientError()), timeoutMs);
        req.on("close", () => {
          clearTimeout(deadline);
        });
        req.on("error", () => {
          reject(new DeployClientError());
        });
        req.end();
      });
      return contract.responseSchema.parse(JSON.parse(body)) as ApiContractResponse<TContract>;
    } catch {
      // Native transport and validation failures may contain upstream values or credentials.
      throw new DeployClientError();
    }
  }

  return {
    getState: () => read(deployStateContract, {}),
    getHealth: async (app) => {
      const result = await read(deployHealthHistoryContract, { app });
      if (
        result.app !== app ||
        result.current.app !== app ||
        result.recent.some((entry) => entry.app !== app)
      ) {
        throw new DeployClientError();
      }
      return result;
    },
  };
}
