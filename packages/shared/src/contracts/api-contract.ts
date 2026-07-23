import type { z } from "zod";

export type ApiContractMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export interface ApiContract<
  TResponseSchema extends z.ZodType = z.ZodType,
  TBodySchema extends z.ZodType | undefined = z.ZodType | undefined,
  TQuerySchema extends z.ZodType | undefined = z.ZodType | undefined,
> {
  readonly method: ApiContractMethod;
  readonly path: `/${string}`;
  readonly responseSchema: TResponseSchema;
  /** Request body schema, when this contract's method accepts a body. Omit for body-less contracts. */
  readonly bodySchema?: TBodySchema;
  /** Querystring schema, when this contract accepts query parameters. Omit for query-less contracts. */
  readonly querySchema?: TQuerySchema;
}

export function defineApiContract<
  const TResponseSchema extends z.ZodType,
  const TBodySchema extends z.ZodType | undefined = undefined,
  const TQuerySchema extends z.ZodType | undefined = undefined,
>(
  contract: ApiContract<TResponseSchema, TBodySchema, TQuerySchema>,
): ApiContract<TResponseSchema, TBodySchema, TQuerySchema> {
  return contract;
}

export type ApiContractResponse<TContract extends ApiContract> = z.output<
  TContract["responseSchema"]
>;

/**
 * The request body type a caller supplies for `TContract`, inferred as
 * `z.input` of its `bodySchema` (the pre-validation shape the caller
 * constructs). Resolves to `never` when the contract defines no
 * `bodySchema`.
 *
 * `bodySchema` is an optional `ApiContract` field, so accessing it always
 * types as `TBodySchema | undefined` even when a concrete schema is
 * present (that is how optional properties read in TypeScript). The
 * `extends undefined` check first, then `Exclude<..., undefined>`, avoids
 * naively checking `TContract["bodySchema"] extends z.ZodType`, which
 * would incorrectly fail for a present schema because the union includes
 * `undefined`.
 */
export type ApiContractBody<TContract extends ApiContract> = TContract["bodySchema"] extends undefined
  ? never
  : z.input<Exclude<TContract["bodySchema"], undefined>>;

/**
 * The query parameters type a caller supplies for `TContract`, inferred as
 * `z.input` of its `querySchema` (the pre-validation shape the caller
 * constructs). Resolves to `undefined` when the contract defines no
 * `querySchema`. See {@link ApiContractBody} for why the check is written
 * as `extends undefined` rather than `extends z.ZodType`.
 */
export type ApiContractQuery<TContract extends ApiContract> = TContract["querySchema"] extends undefined
  ? undefined
  : z.input<Exclude<TContract["querySchema"], undefined>>;
