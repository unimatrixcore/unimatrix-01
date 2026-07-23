import fastifyMultipart from "@fastify/multipart";
import { getAuthUserId, requireAuth } from "@unimatrix/auth/server";
import {
  dataKeySchema,
  dataNamespaceSchema,
  deleteDocumentBodySchema,
  deleteDocumentContract,
  deleteFileBodySchema,
  deleteFileContract,
  getDocumentContract,
  getDocumentQuerySchema,
  listDocumentsContract,
  listDocumentsQuerySchema,
  listFilesContract,
  listFilesQuerySchema,
  putDocumentBodySchema,
  putDocumentContract,
  userFileMetadataSchema,
  type UserFileMetadata,
} from "@unimatrix/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { ApiError } from "../../lib/http/errors.js";

/**
 * Content types safe to serve `inline` from an app origin. Deliberately
 * raster images only — HTML and SVG can carry script, so they (and anything
 * else) are served as downloads instead. See the download route below.
 */
const INLINE_SAFE_CONTENT_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
import {
  deleteDocument,
  deleteFile,
  getDocument,
  getFile,
  listDocuments,
  listFiles,
  putDocument,
  putFile,
} from "./store.js";

/**
 * Every route in this module is gated by `requireAuth()`, and the acting
 * user is always the verified Clerk session's user id — NEVER a value
 * supplied by client input. `requireAuth()` already rejects requests with
 * no session before a handler runs, so a `null` result here is an
 * unexpected/defensive case rather than a normal control-flow path.
 */
function getRequiredAuthUserId(request: FastifyRequest): string {
  const userId = getAuthUserId(request);

  if (userId === null) {
    throw new ApiError({
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "Authentication is required to access this resource.",
    });
  }

  return userId;
}

export const userDataModule: FastifyPluginAsync = async (app) => {
  const { clerk } = app.runtimeConfig;

  if (clerk === null) {
    throw new Error(
      "userDataModule requires app.runtimeConfig.clerk to be configured; only register it when Clerk is set up.",
    );
  }

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: app.runtimeConfig.maxUploadBytes,
    },
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: getDocumentContract.method,
    url: getDocumentContract.path,
    preHandler: requireAuth(),
    schema: {
      querystring: getDocumentQuerySchema,
      response: {
        200: getDocumentContract.responseSchema,
      },
    },
    handler: async (request) => {
      const userId = getRequiredAuthUserId(request);
      const { namespace, key } = request.query;
      const document = await getDocument(app.db, userId, namespace, key);

      if (document === undefined) {
        throw new ApiError({
          statusCode: 404,
          code: "NOT_FOUND",
          message: `No document found for namespace ${JSON.stringify(namespace)} and key ${JSON.stringify(key)}.`,
        });
      }

      return document;
    },
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: putDocumentContract.method,
    url: putDocumentContract.path,
    preHandler: requireAuth(),
    schema: {
      body: putDocumentBodySchema,
      response: {
        200: putDocumentContract.responseSchema,
      },
    },
    handler: async (request) => {
      const userId = getRequiredAuthUserId(request);
      const { namespace, key, value } = request.body;

      return putDocument(app.db, userId, namespace, key, value);
    },
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: deleteDocumentContract.method,
    url: deleteDocumentContract.path,
    preHandler: requireAuth(),
    schema: {
      body: deleteDocumentBodySchema,
      response: {
        200: deleteDocumentContract.responseSchema,
      },
    },
    handler: async (request) => {
      const userId = getRequiredAuthUserId(request);
      const { namespace, key } = request.body;
      const deleted = await deleteDocument(app.db, userId, namespace, key);

      return { deleted };
    },
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: listDocumentsContract.method,
    url: listDocumentsContract.path,
    preHandler: requireAuth(),
    schema: {
      querystring: listDocumentsQuerySchema,
      response: {
        200: listDocumentsContract.responseSchema,
      },
    },
    handler: async (request) => {
      const userId = getRequiredAuthUserId(request);
      const { namespace } = request.query;
      const documents = await listDocuments(app.db, userId, namespace);

      return { documents };
    },
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: listFilesContract.method,
    url: listFilesContract.path,
    preHandler: requireAuth(),
    schema: {
      querystring: listFilesQuerySchema,
      response: {
        200: listFilesContract.responseSchema,
      },
    },
    handler: async (request) => {
      const userId = getRequiredAuthUserId(request);
      const { namespace } = request.query;
      const files = await listFiles(app.db, userId, namespace);

      return { files };
    },
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: deleteFileContract.method,
    url: deleteFileContract.path,
    preHandler: requireAuth(),
    schema: {
      body: deleteFileBodySchema,
      response: {
        200: deleteFileContract.responseSchema,
      },
    },
    handler: async (request) => {
      const userId = getRequiredAuthUserId(request);
      const { namespace, key } = request.body;
      const deleted = await deleteFile(app.db, userId, namespace, key);

      return { deleted };
    },
  });

  // Binary routes: not contract-driven (files are not JSON), so namespace
  // and key are validated manually with the shared zod schemas instead of
  // going through the zod type provider.
  app.route({
    method: "POST",
    url: "/me/files",
    preHandler: requireAuth(),
    handler: async (request, reply) => {
      const userId = getRequiredAuthUserId(request);
      const query = request.query as Record<string, unknown>;

      const namespaceResult = dataNamespaceSchema.safeParse(query.namespace);
      const keyResult = dataKeySchema.safeParse(query.key);

      if (!namespaceResult.success || !keyResult.success) {
        throw new ApiError({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message: "namespace and key query parameters must be valid.",
        });
      }

      const file = await request.file();

      if (file === undefined) {
        throw new ApiError({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message: "A multipart file part is required.",
        });
      }

      // `throwFileSizeLimit` defaults to true in @fastify/multipart v4+, so
      // toBuffer() throws (413) if the stream exceeds the configured
      // fileSize limit rather than silently truncating.
      const data = await file.toBuffer();

      const metadata = await putFile(
        app.db,
        userId,
        namespaceResult.data,
        keyResult.data,
        file.mimetype,
        data.length,
        data,
      );

      const responseBody: UserFileMetadata = userFileMetadataSchema.parse(metadata);

      reply.status(200);

      return responseBody;
    },
  });

  app.route({
    method: "GET",
    url: "/me/files/content",
    preHandler: requireAuth(),
    handler: async (request, reply) => {
      const userId = getRequiredAuthUserId(request);
      const query = request.query as Record<string, unknown>;

      const namespaceResult = dataNamespaceSchema.safeParse(query.namespace);
      const keyResult = dataKeySchema.safeParse(query.key);

      if (!namespaceResult.success || !keyResult.success) {
        throw new ApiError({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message: "namespace and key query parameters must be valid.",
        });
      }

      const file = await getFile(app.db, userId, namespaceResult.data, keyResult.data);

      if (file === undefined) {
        throw new ApiError({
          statusCode: 404,
          code: "NOT_FOUND",
          message: `No file found for namespace ${JSON.stringify(namespaceResult.data)} and key ${JSON.stringify(keyResult.data)}.`,
        });
      }

      // The stored Content-Type is attacker-controlled (it comes from whatever
      // the user uploaded), and this endpoint serves it back from an app
      // origin. Serving e.g. text/html or scripted SVG `inline` would be a
      // stored-XSS vector, so only a raster-image allowlist is served inline;
      // everything else is forced to download. `nosniff` stops the browser
      // from second-guessing the declared type. `keyResult.data` is already
      // constrained to `[A-Za-z0-9._-]+`, so it is safe inside the header.
      const disposition = INLINE_SAFE_CONTENT_TYPES.has(file.contentType.toLowerCase())
        ? "inline"
        : "attachment";

      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Type", file.contentType);
      reply.header("Content-Disposition", `${disposition}; filename="${keyResult.data}"`);

      return reply.send(file.data);
    },
  });
};
