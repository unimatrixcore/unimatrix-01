import { z } from "zod";

/** Content collections managed by the CMS. Home/about stay repo-backed. */
export const contentPostTypeSchema = z.enum(["blog", "project"]);

export type ContentPostType = z.output<typeof contentPostTypeSchema>;

/**
 * Publication lifecycle of a post. Distinct from `projectStatus`, which is
 * the free-form state of the project itself ("live", "archived", ...) and
 * drives the public-site status badge.
 */
export const contentPublicationStateSchema = z.enum(["draft", "published", "archived"]);

export type ContentPublicationState = z.output<typeof contentPublicationStateSchema>;

/**
 * URL slug for a post. Lowercase, hyphen-separated, and never leading with a
 * hyphen, so it is safe as a path segment and stable in a route.
 */
export const contentSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

export type ContentSlug = z.output<typeof contentSlugSchema>;

/** Server-generated post identifier. */
export const contentPostIdSchema = z.uuid();

export type ContentPostId = z.output<typeof contentPostIdSchema>;

/**
 * Lowercase hex SHA-256 of an asset's bytes. Doubles as the asset's public
 * URL segment, which is why it is constrained rather than free-form.
 */
export const contentAssetHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export type ContentAssetHash = z.output<typeof contentAssetHashSchema>;

/**
 * Upper bound on a post body, applied at the external boundary. Large enough
 * for any realistic article (roughly 40k words) and small enough that a
 * runaway paste cannot produce an unbounded row or response.
 */
export const CONTENT_BODY_MAX_LENGTH = 262_144;

const titleSchema = z.string().min(1).max(200);
const summarySchema = z.string().min(1).max(500);
const descriptionSchema = z.string().min(1).max(1000);
const bodySchema = z.string().min(1).max(CONTENT_BODY_MAX_LENGTH);
const projectStatusSchema = z.string().min(1).max(64);
/**
 * Schemes a stored, later-rendered URL may use.
 *
 * `z.url()` on its own accepts anything the WHATWG parser accepts, including
 * `javascript:` and `data:`. `packages/ui`'s `sanitizeMarkdownLink` already
 * allows only http/https on the markdown path, so without this the two paths
 * disagree about what a safe URL is.
 *
 * Not currently exploitable — React 19 refuses to render a `javascript:`
 * href, `data:` loads with an opaque origin, and the only writer today is
 * admin-gated. The point is that the contract stops depending on all three
 * of those staying true; the planned unauthenticated feedback-intake route
 * would be the first writer none of them covers.
 */
const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Declared for the same reason as `TextEncoder` in `./user-data.ts`: this
 * package's `lib` is `["ES2023"]` with no DOM and no `@types/node`, and
 * widening it would weaken the boundary. Module-scoped, so nothing leaks.
 *
 * The parser rather than a `/^https?:\/\//` regex on purpose. `https:/a.dev`
 * and `https:a.dev` are accepted by `z.url()` and normalize to
 * `https://a.dev`, but a lexical `//` check rejects them — verified against
 * zod 4.4.3. For a scheme allowlist, agreeing with the parser that the
 * browser will also use is what makes the check meaningful.
 */
declare const URL: {
  new (url: string): { protocol: string };
};

function hasAllowedUrlProtocol(value: string): boolean {
  try {
    return ALLOWED_URL_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

const urlSchema = z
  .url()
  .max(2048)
  .refine(hasAllowedUrlProtocol, { message: "URL must use the http or https scheme." });

/**
 * A post as it appears in a list: everything needed to render an index row
 * or an admin table, minus the body. Bodies are only ever sent by the detail
 * routes, so a list of long articles stays a small response.
 *
 * Project-only fields are `null` on blog entries rather than absent, so the
 * shape is uniform across both collections.
 */
export const contentPostSummarySchema = z.strictObject({
  id: contentPostIdSchema,
  type: contentPostTypeSchema,
  slug: contentSlugSchema,
  title: titleSchema,
  summary: summarySchema,
  description: descriptionSchema.nullable(),
  publicationState: contentPublicationStateSchema,
  publishedAt: z.string().nullable(),
  featured: z.boolean(),
  projectStatus: projectStatusSchema.nullable(),
  repoUrl: urlSchema.nullable(),
  liveUrl: urlSchema.nullable(),
  updatedAt: z.string(),
});

export type ContentPostSummary = z.output<typeof contentPostSummarySchema>;

/** A post with its markdown body, as returned by the detail routes. */
export const contentPostSchema = contentPostSummarySchema.extend({
  body: bodySchema,
});

export type ContentPost = z.output<typeof contentPostSchema>;

const contentCursorTupleSchema = z.tuple([z.string().max(64), z.string().min(1).max(128)]);

export const contentListCursorSchema = z
  .string()
  .max(512)
  .refine((value) => {
    try {
      return contentCursorTupleSchema.safeParse(JSON.parse(value)).success;
    } catch {
      return false;
    }
  }, "Invalid content cursor");

const contentPagingFields = {
  cursor: contentListCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
};

export const listPostsQuerySchema = z.strictObject({
  type: contentPostTypeSchema,
  featured: z.enum(["true", "false"]).optional(),
  ...contentPagingFields,
});

export type ListPostsQuery = z.output<typeof listPostsQuerySchema>;

export const listPostsResponseSchema = z.strictObject({
  posts: z.array(contentPostSummarySchema),
  nextCursor: contentListCursorSchema.nullable().optional(),
});

export type ListPostsResponse = z.output<typeof listPostsResponseSchema>;

export const getPostQuerySchema = z.strictObject({
  type: contentPostTypeSchema,
  slug: contentSlugSchema,
});

export type GetPostQuery = z.output<typeof getPostQuerySchema>;

/**
 * Admin listing filters. Both are optional: with neither, the response
 * covers every collection and every lifecycle state except soft-deleted
 * rows, which is what the bulk-management table wants by default.
 */
export const adminListPostsQuerySchema = z.strictObject({
  type: contentPostTypeSchema.optional(),
  publicationState: contentPublicationStateSchema.optional(),
  ...contentPagingFields,
});

export type AdminListPostsQuery = z.output<typeof adminListPostsQuerySchema>;

/**
 * Fields an admin supplies when creating a post. `publishedAt` is server-owned
 * (stamped on first publish) and the audit columns come from the verified
 * session, so neither is accepted here.
 */
export const createPostBodySchema = z.strictObject({
  type: contentPostTypeSchema,
  slug: contentSlugSchema,
  title: titleSchema,
  summary: summarySchema,
  description: descriptionSchema.nullish(),
  body: bodySchema,
  publicationState: contentPublicationStateSchema.default("draft"),
  featured: z.boolean().default(false),
  projectStatus: projectStatusSchema.nullish(),
  repoUrl: urlSchema.nullish(),
  liveUrl: urlSchema.nullish(),
});

export type CreatePostBody = z.output<typeof createPostBodySchema>;

/**
 * A partial update addressed by `id`. Every content field is optional;
 * omitted fields keep their stored value, and an explicit `null` clears a
 * nullable one.
 */
export const updatePostBodySchema = z.strictObject({
  id: contentPostIdSchema,
  slug: contentSlugSchema.optional(),
  title: titleSchema.optional(),
  summary: summarySchema.optional(),
  description: descriptionSchema.nullish(),
  body: bodySchema.optional(),
  publicationState: contentPublicationStateSchema.optional(),
  featured: z.boolean().optional(),
  projectStatus: projectStatusSchema.nullish(),
  repoUrl: urlSchema.nullish(),
  liveUrl: urlSchema.nullish(),
});

export type UpdatePostBody = z.output<typeof updatePostBodySchema>;

/**
 * Bulk selection for the admin table. Capped so one request cannot sweep an
 * unbounded number of rows, and non-empty so a no-op selection is a
 * validation error rather than a silent success.
 */
const postIdsSchema = z.array(contentPostIdSchema).min(1).max(100);

export const setPostsStateBodySchema = z.strictObject({
  ids: postIdsSchema,
  publicationState: contentPublicationStateSchema,
});

export type SetPostsStateBody = z.output<typeof setPostsStateBodySchema>;

export const deletePostsBodySchema = z.strictObject({
  ids: postIdsSchema,
});

export type DeletePostsBody = z.output<typeof deletePostsBodySchema>;

/** How many rows a bulk operation actually touched. */
export const bulkResultSchema = z.strictObject({
  affected: z.number().int().nonnegative(),
});

export type BulkResult = z.output<typeof bulkResultSchema>;

export const contentAssetMetadataSchema = z.strictObject({
  hash: contentAssetHashSchema,
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  originalFilename: z.string(),
  createdAt: z.string(),
});

export type ContentAssetMetadata = z.output<typeof contentAssetMetadataSchema>;

export const listAssetsResponseSchema = z.strictObject({
  assets: z.array(contentAssetMetadataSchema),
});

export type ListAssetsResponse = z.output<typeof listAssetsResponseSchema>;
