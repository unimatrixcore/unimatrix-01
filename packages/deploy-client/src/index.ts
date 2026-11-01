import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import {
  deployAttemptHistoryContract,
  deployManualRedeployContract,
  deployRollbackContract,
  deployAttemptLogsContract,
  deployDeclarationsContract,
  deployHealthHistoryContract,
  deployReconciliationContract,
  deployStateContract,
  type ApiContract,
  type ApiContractBody,
  type ApiContractQuery,
  type ApiContractResponse,
  type DeployHealthHistoryResponse,
  type DeployDeclarationsResponse,
  type DeployReconciliationResponse,
  type DeployStateResponse,
  type DeployAttemptLogsQuery,
  type DeployAttemptLogsResponse,
} from "@unimatrix/shared";

export interface DeployClientConfig {
  baseUrl: string;
  serviceToken: string;
  caCertificatePem?: string;
  timeoutMs?: number;
}

export interface DeployClient {
  rollback(input: DeployRollbackInput): Promise<DeployRollbackResponse>;
  redeploy(input: DeployManualRedeployInput): Promise<DeployManualRedeployResponse>;
  getDeclarations(query?: DeployAppQuery): Promise<DeployDeclarationsResponse>;
  getState(query?: DeployAppQuery): Promise<DeployStateResponse>;
  getHealth(app: string): Promise<DeployHealthHistoryResponse>;
  getReconciliation(query?: DeployAppQuery): Promise<DeployReconciliationResponse>;
  getAttempts(query?: DeployAttemptHistoryQuery): Promise<DeployAttemptHistoryResponse>;
  getAttemptLogs(query: DeployAttemptLogsQuery): Promise<DeployAttemptLogsResponse>;
}

export type DeployAppQuery = ApiContractQuery<typeof deployStateContract>;
export type DeployManualRedeployInput = ApiContractBody<typeof deployManualRedeployContract>;
export type DeployManualRedeployResponse = ApiContractResponse<typeof deployManualRedeployContract>;
export type DeployRollbackInput = ApiContractBody<typeof deployRollbackContract>;
export type DeployRollbackResponse = ApiContractResponse<typeof deployRollbackContract>;
export type DeployAttemptHistoryQuery = Omit<
  ApiContractQuery<typeof deployAttemptHistoryContract>,
  "limit"
> & { limit?: number };
export type DeployAttemptHistoryResponse = ApiContractResponse<typeof deployAttemptHistoryContract>;

export class DeployClientError extends Error {
  readonly statusCode: 404 | 409 | undefined;

  constructor(statusCode?: 404 | 409) {
    super("Deployment read unavailable");
    this.name = "DeployClientError";
    this.statusCode = statusCode;
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

  async function send<TContract extends ApiContract>(
    contract: TContract,
    query: Record<string, string | number | undefined>,
    input?: unknown,
  ): Promise<ApiContractResponse<TContract>> {
    try {
      const parsedQuery: unknown = contract.querySchema?.parse(query);
      const payload =
        input === undefined ? undefined : JSON.stringify(contract.bodySchema?.parse(input));
      const url = new URL(contract.path, origin);
      for (const [key, value] of Object.entries(
        (parsedQuery ?? {}) as Record<string, string | number | undefined>,
      )) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      const body = await new Promise<string>((resolve, reject) => {
        const request = origin.protocol === "https:" ? httpsRequest : httpRequest;
        const req = request(
          url,
          {
            agent: false,
            method: contract.method,
            headers: {
              accept: "application/json",
              authorization: `Bearer ${config.serviceToken}`,
              ...(payload === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(origin.protocol === "https:" ? { ca: config.caCertificatePem } : {}),
          },
          (response) => {
            if (response.statusCode !== 200) {
              response.destroy();
              reject(
                new DeployClientError(
                  contract.method === "POST" &&
                    (contract.path === deployManualRedeployContract.path ||
                      contract.path === deployRollbackContract.path) &&
                    (response.statusCode === 404 || response.statusCode === 409)
                    ? response.statusCode
                    : undefined,
                ),
              );
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
        req.end(payload);
      });
      return contract.responseSchema.parse(JSON.parse(body)) as ApiContractResponse<TContract>;
    } catch (error) {
      // Native transport and validation failures may contain upstream values or credentials.
      if (error instanceof DeployClientError) throw error;
      throw new DeployClientError();
    }
  }

  return {
    rollback: async (input) => {
      const result = await send(deployRollbackContract, {}, input);
      if (
        result.app !== input.app ||
        result.requestId !== input.requestId ||
        result.actorUserId !== input.actorUserId ||
        result.targetAttemptId !== input.targetAttemptId ||
        result.trigger !== "rollback" ||
        result.image === null
      ) {
        throw new DeployClientError();
      }
      return result;
    },
    redeploy: async (input) => {
      const result = await send(deployManualRedeployContract, {}, input);
      if (
        result.app !== input.app ||
        result.requestId !== input.requestId ||
        result.actorUserId !== input.actorUserId ||
        result.trigger !== "manual" ||
        result.image !== null
      ) {
        throw new DeployClientError();
      }
      return result;
    },
    getAttemptLogs: async (query) => {
      const result = await send(deployAttemptLogsContract, query);
      if (result.app !== query.app || result.attemptId !== query.attemptId) {
        throw new DeployClientError();
      }
      return result;
    },
    getDeclarations: async (query = {}) => {
      const result = await send(deployDeclarationsContract, query);
      if (result.apps.some((entry) => query.app !== undefined && entry.appDir !== query.app)) {
        throw new DeployClientError();
      }
      return result;
    },
    getState: async (query = {}) => {
      const result = await send(deployStateContract, query);
      if (
        result.apps.some(
          (entry) =>
            (query.app !== undefined && entry.appDir !== query.app) ||
            entry.container.appDir !== entry.appDir,
        )
      ) {
        throw new DeployClientError();
      }
      return result;
    },
    getHealth: async (app) => {
      const result = await send(deployHealthHistoryContract, { app });
      if (
        result.app !== app ||
        result.current.app !== app ||
        result.recent.some((entry) => entry.app !== app)
      ) {
        throw new DeployClientError();
      }
      return result;
    },
    getReconciliation: async (query = {}) => {
      const result = await send(deployReconciliationContract, query);
      if (
        result.results.some(
          (entry) =>
            (query.app !== undefined && entry.appDir !== query.app) ||
            (entry.outcome === "diffed" && entry.diff.appDir !== entry.appDir),
        )
      ) {
        throw new DeployClientError();
      }
      return result;
    },
    getAttempts: async (query = {}) => {
      const result = await send(deployAttemptHistoryContract, query);
      if (
        result.attempts.length > (query.limit ?? 50) ||
        result.attempts.some((entry) => query.app !== undefined && entry.app !== query.app)
      ) {
        throw new DeployClientError();
      }
      return result;
    },
  };
}
