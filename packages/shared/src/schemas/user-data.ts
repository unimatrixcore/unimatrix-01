import { z } from "zod";

/**
 * A namespace groups a user's documents/files into a logical bucket (for
 * example, a service or feature slug). Kept as a lowercase, hyphenated slug
 * so it is safe to use as a path segment or storage key component.
 */
export const dataNamespaceSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export type DataNamespace = z.output<typeof dataNamespaceSchema>;

/**
 * A key identifies a single document/file within a namespace.
 */
export const dataKeySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);

export type DataKey = z.output<typeof dataKeySchema>;

/**
 * A document's JSON value. Rejects `undefined` — and a missing `value`
 * property, since this is not `z.unknown()`/`z.any()` (which Zod treats as
 * optional) — at the external boundary, so the API returns a validation
 * error instead of persisting `JSON.stringify(undefined)` into a NOT NULL
 * column. The output type stays `unknown` so callers can store any JSON
 * value without friction.
 */
export const documentValueSchema = z.custom<unknown>((value) => value !== undefined, {
  message: "value is required and must be a defined JSON value.",
});

export type DocumentValue = z.output<typeof documentValueSchema>;

export const userDocumentSchema = z.strictObject({
  namespace: dataNamespaceSchema,
  key: dataKeySchema,
  value: documentValueSchema,
  updatedAt: z.string(),
});

export type UserDocument = z.output<typeof userDocumentSchema>;

export const getDocumentQuerySchema = z.strictObject({
  namespace: dataNamespaceSchema,
  key: dataKeySchema,
});

export type GetDocumentQuery = z.output<typeof getDocumentQuerySchema>;

export const putDocumentBodySchema = z.strictObject({
  namespace: dataNamespaceSchema,
  key: dataKeySchema,
  value: documentValueSchema,
});

export type PutDocumentBody = z.output<typeof putDocumentBodySchema>;

export const deleteDocumentBodySchema = z.strictObject({
  namespace: dataNamespaceSchema,
  key: dataKeySchema,
});

export type DeleteDocumentBody = z.output<typeof deleteDocumentBodySchema>;

export const listDocumentsQuerySchema = z.strictObject({
  namespace: dataNamespaceSchema,
});

export type ListDocumentsQuery = z.output<typeof listDocumentsQuerySchema>;

export const listDocumentsResponseSchema = z.strictObject({
  documents: z.array(userDocumentSchema),
});

export type ListDocumentsResponse = z.output<typeof listDocumentsResponseSchema>;

export const deleteResultSchema = z.strictObject({
  deleted: z.boolean(),
});

export type DeleteResult = z.output<typeof deleteResultSchema>;

export const userFileMetadataSchema = z.strictObject({
  namespace: dataNamespaceSchema,
  key: dataKeySchema,
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  updatedAt: z.string(),
});

export type UserFileMetadata = z.output<typeof userFileMetadataSchema>;

export const listFilesQuerySchema = z.strictObject({
  namespace: dataNamespaceSchema,
});

export type ListFilesQuery = z.output<typeof listFilesQuerySchema>;

export const listFilesResponseSchema = z.strictObject({
  files: z.array(userFileMetadataSchema),
});

export type ListFilesResponse = z.output<typeof listFilesResponseSchema>;

export const deleteFileBodySchema = z.strictObject({
  namespace: dataNamespaceSchema,
  key: dataKeySchema,
});

export type DeleteFileBody = z.output<typeof deleteFileBodySchema>;
