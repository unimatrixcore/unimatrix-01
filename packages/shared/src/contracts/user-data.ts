import {
  deleteDocumentBodySchema,
  deleteFileBodySchema,
  deleteResultSchema,
  getDocumentQuerySchema,
  listDocumentsQuerySchema,
  listDocumentsResponseSchema,
  listFilesQuerySchema,
  listFilesResponseSchema,
  putDocumentBodySchema,
  userDocumentSchema,
} from "../schemas/user-data.js";
import { defineApiContract } from "./api-contract.js";

export const getDocumentContract = defineApiContract({
  method: "GET",
  path: "/me/data",
  querySchema: getDocumentQuerySchema,
  responseSchema: userDocumentSchema,
});

export type GetDocumentContract = typeof getDocumentContract;

export const putDocumentContract = defineApiContract({
  method: "PUT",
  path: "/me/data",
  bodySchema: putDocumentBodySchema,
  responseSchema: userDocumentSchema,
});

export type PutDocumentContract = typeof putDocumentContract;

export const deleteDocumentContract = defineApiContract({
  method: "DELETE",
  path: "/me/data",
  bodySchema: deleteDocumentBodySchema,
  responseSchema: deleteResultSchema,
});

export type DeleteDocumentContract = typeof deleteDocumentContract;

export const listDocumentsContract = defineApiContract({
  method: "GET",
  path: "/me/data/list",
  querySchema: listDocumentsQuerySchema,
  responseSchema: listDocumentsResponseSchema,
});

export type ListDocumentsContract = typeof listDocumentsContract;

export const listFilesContract = defineApiContract({
  method: "GET",
  path: "/me/files",
  querySchema: listFilesQuerySchema,
  responseSchema: listFilesResponseSchema,
});

export type ListFilesContract = typeof listFilesContract;

export const deleteFileContract = defineApiContract({
  method: "DELETE",
  path: "/me/files",
  bodySchema: deleteFileBodySchema,
  responseSchema: deleteResultSchema,
});

export type DeleteFileContract = typeof deleteFileContract;
