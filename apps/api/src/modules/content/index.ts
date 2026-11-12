import { createHash } from "node:crypto";

import fastifyMultipart from "@fastify/multipart";
import fastifyRateLimit from "@fastify/rate-limit";
import { getAuthUserId, requirePermission } from "@unimatrix/auth/server";
import {
  adminGetPostContract,
  adminListPostsContract,
  adminListPostsQuerySchema,
  contentAssetHashSchema,
  createPostBodySchema,
  createPostContract,
  deletePostsBodySchema,
  deletePostsContract,
  getPostContract,
  getPostQuerySchema,
  listAssetsContract,
  listPostsContract,
  listPostsQuerySchema,
  setPostsStateBodySchema,
  setPostsStateContract,
  updatePostBodySchema,
  updatePostContract,
  type ContentAssetMetadata,
  type ContentPost,
  type ContentPostSummary,
} from "@unimatrix/shared";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { isInlineSafeContentType } from "../../lib/http/content-types.js";
import { ApiError } from "../../lib/http/errors.js";
import { RATE_LIMIT_OPTIONS, UPLOAD_RATE_LIMIT_OPTIONS } from "../../plugins/rate-limit.js";
import {
  createPost,
  deletePosts,
  getAsset,
  getPostById,
  getPostForAdmin,
  getPublishedPost,
  listAssets,
  listPostsForAdmin,
  listContentPage,
  listPublishedPosts,
  putAsset,
  setPostsState,
  slugExists,
  updatePost,
} from "./store.js";

/**
 * Public content is read far more often than it changes, but it must go live
 * the moment it is published — a long max-age would make the CMS feel broken.
 * A short freshness window plus revalidation gives the browser a cheap 304 on
 * the common path without delaying a publish.
 */
const PUBLIC_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

/**
 * Assets are addressed by the hash of their bytes, so a given URL can never
 * return different content. That makes an immutable, year-long cache correct
 * rather than merely convenient.
 */
const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Uploads are restricted to the formats that are safe to serve inline. */
const UPLOAD_ERROR_MESSAGE =
  "Only image/avif, image/gif, image/jpeg, image/png and image/webp uploads are accepted.";

/**
 * Admin routes run behind `requirePermission("auth", "admin")`, which rejects
 * unauthenticated and unauthorized requests before a handler runs, so a
 * `null` user id here is defensive rather than a normal path.
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

/**
 * The separator is written as an escape rather than a literal control
 * character: a raw NUL in the source makes git and grep classify this whole
 * file as binary, so its diff renders as "Binary files differ" and it drops
 * out of every `grep -r` in the repo. It stays a NUL because it is the one
 * byte that cannot appear in an id or a timestamp, so no two distinct part
 * lists can join into the same string.
 */
function buildEtag(parts: readonly string[]): string {
  const hash = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);

  return `"${hash}"`;
}

/**
 * Applies the public cache headers and answers a matching conditional
 * request with 304. Returns `true` when the response has been completed, so
 * the caller can stop without serializing a body.
 *
 * Fastify emits no ETag of its own; these are computed from the rows that
 * were actually read, which keeps the dependency surface unchanged and makes
 * the tag change exactly when the content does.
 */
function applyPublicCache(request: FastifyRequest, reply: FastifyReply, etag: string): boolean {
  reply.header("cache-control", PUBLIC_CACHE_CONTROL);
  reply.header("etag", etag);

  if (request.headers["if-none-match"] === etag) {
    reply.status(304).send();

    return true;
  }

  return false;
}

function buildListEtag(posts: readonly ContentPostSummary[]): string {
  return buildEtag([String(posts.length), ...posts.map((post) => `${post.id}:${post.updatedAt}`)]);
}

function buildPostEtag(post: ContentPost): string {
  return buildEtag([post.id, post.updatedAt]);
}

/**
 * Public read routes are registered unconditionally — the public site must
 * render its blog and project pages whether or not Clerk is configured.
 * Admin routes are registered only alongside a configured Clerk, since
 * `requirePermission()` needs `registerClerkAuth()` to have run.
 */
export const contentModule: FastifyPluginAsync = async (app) => {
  // Registered here as well as globally in `src/plugins/rate-limit.ts`. The
  // modules are encapsulated plugins, so the ceiling installed on the root
  // instance is not visible from inside one — not to a reader of this file and
  // not to CodeQL, which reports every authorizing route here as unlimited.
  // Both limiters count the same request against equal budgets, so the
  // effective ceiling is unchanged; what changes is that the guarantee is
  // stated where the routes that need it are.
  await app.register(fastifyRateLimit, RATE_LIMIT_OPTIONS);

  app.withTypeProvider<ZodTypeProvider>().route({
    method: listPostsContract.method,
    url: listPostsContract.path,
    schema: {
      querystring: listPostsQuerySchema,
      response: {
        200: listPostsContract.responseSchema,
      },
    },
    handler: async (request, reply) => {
      const result =
        request.query.limit !== undefined ||
        request.query.cursor !== undefined ||
        request.query.featured !== undefined
          ? await listContentPage(app.db, request.query, "public")
          : { posts: await listPublishedPosts(app.db, request.query.type) };
      const etag = buildEtag([buildListEtag(result.posts), JSON.stringify(result)]);

      if (applyPublicCache(request, reply, etag)) {
        return reply;
      }

      return result;
    },
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: getPostContract.method,
    url: getPostContract.path,
    schema: {
      querystring: getPostQuerySchema,
      response: {
        200: getPostContract.responseSchema,
      },
    },
    handler: async (request, reply) => {
      const { type, slug } = request.query;
      const post = await getPublishedPost(app.db, type, slug);

      if (post === undefined) {
        throw new ApiError({
          statusCode: 404,
          code: "NOT_FOUND",
          message: `No published ${type} entry found for slug ${JSON.stringify(slug)}.`,
        });
      }

      if (applyPublicCache(request, reply, buildPostEtag(post))) {
        return reply;
      }

      return post;
    },
  });

  // Binary route: not contract-driven (assets are not JSON), so the hash is
  // validated manually with the shared zod schema instead of going through
  // the type provider. Public by design — the URL is the content hash, and
  // an asset is only reachable once it has been embedded in a post.
  app.route({
    method: "GET",
    url: "/content/assets/:hash",
    handler: async (request, reply) => {
      const params = request.params as Record<string, unknown>;
      const hashResult = contentAssetHashSchema.safeParse(params.hash);

      if (!hashResult.success) {
        throw new ApiError({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message: "The asset hash must be a lowercase hex SHA-256 digest.",
        });
      }

      const asset = await getAsset(app.db, hashResult.data);

      if (asset === undefined) {
        throw new ApiError({
          statusCode: 404,
          code: "NOT_FOUND",
          message: `No asset found for hash ${JSON.stringify(hashResult.data)}.`,
        });
      }

      const etag = `"${asset.hash}"`;

      reply.header("cache-control", ASSET_CACHE_CONTROL);
      reply.header("etag", etag);
      // Helmet's global default is `same-origin`, which blocks the `<img>` no-cors
      // load this asset feeds on both the admin origin (editor preview) and the
      // public origin (published post) — both are cross-origin from the API. Scoped
      // to this route rather than helmet's config, since it is the only route that
      // needs the wider policy.
      reply.header("cross-origin-resource-policy", "cross-origin");

      if (request.headers["if-none-match"] === etag) {
        return reply.status(304).send();
      }

      // Uploads are allowlisted to raster images, so this is always `inline`
      // today. The check stays because the stored content type is external
      // input, and a widened allowlist upstream must not silently start
      // rendering scriptable types from an app origin. `nosniff` keeps the
      // browser from second-guessing the declared type. The filename is the
      // validated hex hash, so it is safe inside the header.
      const disposition = isInlineSafeContentType(asset.contentType) ? "inline" : "attachment";

      reply.header("x-content-type-options", "nosniff");
      reply.header("content-type", asset.contentType);
      reply.header("content-disposition", `${disposition}; filename="${asset.hash}"`);

      return reply.send(asset.data);
    },
  });

  if (app.runtimeConfig.clerk === null) {
    return;
  }

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: app.runtimeConfig.maxUploadBytes,
    },
  });

  const requireAdmin = requirePermission("auth", "admin");

  app.withTypeProvider<ZodTypeProvider>().route({
    method: adminListPostsContract.method,
    url: adminListPostsContract.path,
    preHandler: requireAdmin,
    schema: {
      querystring: adminListPostsQuerySchema,
      response: {
        200: adminListPostsContract.responseSchema,
      },
    },
    handler: async (request) => {
      if (request.query.limit !== undefined || request.query.cursor !== undefined) {
        return listContentPage(app.db, request.query, "admin");
      }
      return { posts: await listPostsForAdmin(app.db, request.query) };
    },
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: adminGetPostContract.method,
    url: adminGetPostContract.path,
    preHandler: requireAdmin,
    schema: {
      querystring: getPostQuerySchema,
      response: {
        200: adminGetPostContract.responseSchema,
      },
    },
    handler: async (request) => {
      const { type, slug } = request.query;
      const post = await getPostForAdmin(app.db, type, slug);

      if (post === undefined) {
        throw new ApiError({
          statusCode: 404,
          code: "NOT_FOUND",
          message: `No ${type} entry found for slug ${JSON.stringify(slug)}.`,
        });
      }

      return post;
    },
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: createPostContract.method,
    url: createPostContract.path,
    preHandler: requireAdmin,
    schema: {
      body: createPostBodySchema,
      response: {
        201: createPostContract.responseSchema,
      },
    },
    handler: async (request, reply) => {
      const userId = getRequiredAuthUserId(request);
      const { type, slug } = request.body;

      if (await slugExists(app.db, type, slug)) {
        throw new ApiError({
          statusCode: 409,
          code: "CLIENT_ERROR",
          message: `A ${type} entry already uses the slug ${JSON.stringify(slug)}.`,
        });
      }

      const post = await createPost(app.db, userId, request.body);

      reply.status(201);

      return post;
    },
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: updatePostContract.method,
    url: updatePostContract.path,
    preHandler: requireAdmin,
    schema: {
      body: updatePostBodySchema,
      response: {
        200: updatePostContract.responseSchema,
      },
    },
    handler: async (request) => {
      const userId = getRequiredAuthUserId(request);
      const { id, slug } = request.body;
      const existing = await getPostById(app.db, id);

      if (existing === undefined) {
        throw createPostNotFoundError(id);
      }

      if (slug !== undefined && (await slugExists(app.db, existing.type, slug, id))) {
        throw new ApiError({
          statusCode: 409,
          code: "CLIENT_ERROR",
          message: `A ${existing.type} entry already uses the slug ${JSON.stringify(slug)}.`,
        });
      }

      const post = await updatePost(app.db, userId, request.body);

      if (post === undefined) {
        throw createPostNotFoundError(id);
      }

      return post;
    },
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: setPostsStateContract.method,
    url: setPostsStateContract.path,
    preHandler: requireAdmin,
    schema: {
      body: setPostsStateBodySchema,
      response: {
        200: setPostsStateContract.responseSchema,
      },
    },
    handler: async (request) => {
      const userId = getRequiredAuthUserId(request);
      const { ids, publicationState } = request.body;
      const affected = await setPostsState(app.db, userId, ids, publicationState);

      return { affected };
    },
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: deletePostsContract.method,
    url: deletePostsContract.path,
    preHandler: requireAdmin,
    schema: {
      body: deletePostsBodySchema,
      response: {
        200: deletePostsContract.responseSchema,
      },
    },
    handler: async (request) => {
      const userId = getRequiredAuthUserId(request);
      const affected = await deletePosts(app.db, userId, request.body.ids);

      return { affected };
    },
  });

  app.withTypeProvider<ZodTypeProvider>().route({
    method: listAssetsContract.method,
    url: listAssetsContract.path,
    preHandler: requireAdmin,
    schema: {
      response: {
        200: listAssetsContract.responseSchema,
      },
    },
    handler: async () => {
      const assets = await listAssets(app.db);

      return { assets };
    },
  });

  // Binary route, same reasoning as the public asset route above.
  // The shorthand form, not `app.route({...})`, and the ceiling in the options
  // argument rather than on the route object. CodeQL's `js/missing-rate-limiting`
  // recognises a per-route limit only on a 3-argument shorthand call — its
  // Fastify rule excludes the method name `route` outright — so the object form
  // reads as an unlimited authorizing route no matter what config it carries.
  app.post(
    "/content/admin/assets",
    {
      config: { rateLimit: UPLOAD_RATE_LIMIT_OPTIONS },
      preHandler: requireAdmin,
    },
    async (request, reply) => {
      const userId = getRequiredAuthUserId(request);
      const file = await request.file();

      if (file === undefined) {
        throw new ApiError({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message: "A multipart file part is required.",
        });
      }

      if (!isInlineSafeContentType(file.mimetype)) {
        throw new ApiError({
          statusCode: 415,
          code: "CLIENT_ERROR",
          message: UPLOAD_ERROR_MESSAGE,
        });
      }

      // `throwFileSizeLimit` defaults to true in @fastify/multipart v4+, so
      // toBuffer() throws (413) if the stream exceeds the configured
      // fileSize limit rather than silently truncating.
      const data = await file.toBuffer();
      const hash = createHash("sha256").update(data).digest("hex");

      const metadata: ContentAssetMetadata = await putAsset(app.db, userId, {
        hash,
        contentType: file.mimetype.toLowerCase(),
        size: data.length,
        data,
        originalFilename: file.filename,
      });

      reply.status(201);

      return metadata;
    },
  );
};

function createPostNotFoundError(id: string): ApiError {
  return new ApiError({
    statusCode: 404,
    code: "NOT_FOUND",
    message: `No content post found for id ${JSON.stringify(id)}.`,
  });
}
