import {
  pokerOperations,
  type PokerOperation,
  type PokerPayload,
  type PokerResult,
} from "@unimatrix/shared";

export type PokerInvoke = (operation: PokerOperation, payload: unknown) => Promise<unknown>;
export type PokerClient = <K extends PokerOperation>(
  operation: K,
  payload: PokerPayload<K>,
) => Promise<PokerResult<K>>;

export function createPokerClient(invoke: PokerInvoke): PokerClient {
  return async <K extends PokerOperation>(
    operation: K,
    payload: PokerPayload<K>,
  ): Promise<PokerResult<K>> => {
    const schema = pokerOperations[operation];
    const validated = schema.request.parse(payload);
    const result = await invoke(operation, validated);
    return schema.response.parse(result) as PokerResult<K>;
  };
}
