import type { z } from "zod";

export type ApiContractMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export interface ApiContract<TResponseSchema extends z.ZodType = z.ZodType> {
  readonly method: ApiContractMethod;
  readonly path: `/${string}`;
  readonly responseSchema: TResponseSchema;
}

export function defineApiContract<const TResponseSchema extends z.ZodType>(
  contract: ApiContract<TResponseSchema>,
): ApiContract<TResponseSchema> {
  return contract;
}

export type ApiContractResponse<TContract extends ApiContract> = z.output<
  TContract["responseSchema"]
>;