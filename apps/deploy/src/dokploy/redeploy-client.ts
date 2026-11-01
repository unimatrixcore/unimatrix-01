import { createDokployTransport, type CreateDokployClientOptions } from "./transport.js";

export interface DokployRedeployClient {
  queueRedeploy(composeId: string, attemptId: string): Promise<void>;
}

export function createDokployRedeployClient(
  options: CreateDokployClientOptions,
): DokployRedeployClient {
  const { callMutation } = createDokployTransport(options);
  return {
    queueRedeploy: (composeId, attemptId) =>
      callMutation("compose.deploy", { composeId, title: `unimatrix-attempt:${attemptId}` }),
  };
}
