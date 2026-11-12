import { randomUUID } from "node:crypto";

import type { DatabaseInstance } from "@unimatrix/db";
import { contentAssetsTable, contentPostsTable } from "@unimatrix/db";
import type {
  AdminListPostsQuery,
  ContentAssetMetadata,
  ContentPost,
  ContentPostSummary,
  ContentPostType,
  CreatePostBody,
  ListPostsQuery,
  ListPostsResponse,
  UpdatePostBody,
} from "@unimatrix/shared";
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

export type ContentDb = DatabaseInstance["db"];

type ContentPostRow = typeof contentPostsTable.$inferSelect;
type ContentPostSummaryRow = Omit<
  ContentPostRow,
  "body" | "createdAt" | "createdBy" | "updatedBy" | "deletedAt"
>;

const summaryColumns = {
  id: contentPostsTable.id,
  type: contentPostsTable.type,
  slug: contentPostsTable.slug,
  title: contentPostsTable.title,
  summary: contentPostsTable.summary,
  description: contentPostsTable.description,
  publicationState: contentPostsTable.publicationState,
  publishedAt: contentPostsTable.publishedAt,
  featured: contentPostsTable.featured,
  projectStatus: contentPostsTable.projectStatus,
  repoUrl: contentPostsTable.repoUrl,
  liveUrl: contentPostsTable.liveUrl,
  updatedAt: contentPostsTable.updatedAt,
} as const;

function toSummary(row: ContentPostSummaryRow): ContentPostSummary {
  return {
    id: row.id,
    type: row.type,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    description: row.description,
    publicationState: row.publicationState,
    publishedAt: row.publishedAt,
    featured: row.featured,
    projectStatus: row.projectStatus,
    repoUrl: row.repoUrl,
    liveUrl: row.liveUrl,
    updatedAt: row.updatedAt,
  };
}

function toPost(row: ContentPostRow): ContentPost {
  return {
    ...toSummary(row),
    body: row.body,
  };
}

function toAssetMetadata(
  row: Pick<
    typeof contentAssetsTable.$inferSelect,
    "hash" | "contentType" | "size" | "originalFilename" | "createdAt"
  >,
): ContentAssetMetadata {
  return {
    hash: row.hash,
    contentType: row.contentType,
    size: row.size,
    originalFilename: row.originalFilename,
    createdAt: row.createdAt,
  };
}

/**
 * Every read path starts here. Soft-deleted rows are excluded at the lowest
 * level rather than at each call site, so forgetting the filter in a new
 * query is not possible without deliberately bypassing this helper.
 */
function notDeleted(): SQL {
  return isNull(contentPostsTable.deletedAt);
}

/** Public visibility: published, not soft-deleted. Drafts never leak. */
function publiclyVisible(type: ContentPostType): SQL {
  return and(
    eq(contentPostsTable.type, type),
    eq(contentPostsTable.publicationState, "published"),
    notDeleted(),
  ) as SQL;
}

export async function listPublishedPosts(
  db: ContentDb,
  type: ContentPostType,
): Promise<ContentPostSummary[]> {
  const rows = await db
    .select(summaryColumns)
    .from(contentPostsTable)
    .where(publiclyVisible(type))
    .orderBy(desc(contentPostsTable.publishedAt));

  return rows.map(toSummary);
}

export async function listContentPage(
  db: ContentDb,
  filters: AdminListPostsQuery | ListPostsQuery,
  visibility: "public" | "admin",
): Promise<ListPostsResponse> {
  const conditions: SQL[] = [notDeleted()];
  if (filters.type !== undefined) conditions.push(eq(contentPostsTable.type, filters.type));
  if (visibility === "public") {
    conditions.push(eq(contentPostsTable.publicationState, "published"));
    if ("featured" in filters && filters.featured !== undefined) {
      conditions.push(eq(contentPostsTable.featured, filters.featured === "true"));
    }
  } else if ("publicationState" in filters && filters.publicationState !== undefined) {
    conditions.push(eq(contentPostsTable.publicationState, filters.publicationState));
  }
  const sortColumn =
    visibility === "public" ? contentPostsTable.publishedAt : contentPostsTable.updatedAt;
  const sortValue = sql<string>`coalesce(${sortColumn}, '')`;
  if (filters.cursor !== undefined) {
    const [time, id] = JSON.parse(filters.cursor) as [string, string];
    conditions.push(sql`(${sortValue}, ${contentPostsTable.id}) < (${time}, ${id})`);
  }
  const limit = filters.limit ?? 50;
  const rows = await db
    .select(summaryColumns)
    .from(contentPostsTable)
    .where(and(...conditions))
    .orderBy(desc(sortValue), desc(contentPostsTable.id))
    .limit(limit + 1);
  const posts = rows.slice(0, limit).map(toSummary);
  const last = posts.at(-1);
  return {
    posts,
    nextCursor:
      rows.length > limit && last !== undefined
        ? JSON.stringify([
            visibility === "public" ? (last.publishedAt ?? "") : last.updatedAt,
            last.id,
          ])
        : null,
  };
}

export async function getPublishedPost(
  db: ContentDb,
  type: ContentPostType,
  slug: string,
): Promise<ContentPost | undefined> {
  const rows = await db
    .select()
    .from(contentPostsTable)
    .where(and(publiclyVisible(type), eq(contentPostsTable.slug, slug)))
    .limit(1);

  const row = rows[0];

  return row === undefined ? undefined : toPost(row);
}

export async function listPostsForAdmin(
  db: ContentDb,
  filters: AdminListPostsQuery,
): Promise<ContentPostSummary[]> {
  const conditions: SQL[] = [notDeleted()];

  if (filters.type !== undefined) {
    conditions.push(eq(contentPostsTable.type, filters.type));
  }

  if (filters.publicationState !== undefined) {
    conditions.push(eq(contentPostsTable.publicationState, filters.publicationState));
  }

  const rows = await db
    .select(summaryColumns)
    .from(contentPostsTable)
    .where(and(...conditions))
    .orderBy(desc(contentPostsTable.updatedAt));

  return rows.map(toSummary);
}

/** Admin read: any lifecycle state, still excluding soft-deleted rows. */
export async function getPostForAdmin(
  db: ContentDb,
  type: ContentPostType,
  slug: string,
): Promise<ContentPost | undefined> {
  const rows = await db
    .select()
    .from(contentPostsTable)
    .where(and(eq(contentPostsTable.type, type), eq(contentPostsTable.slug, slug), notDeleted()))
    .limit(1);

  const row = rows[0];

  return row === undefined ? undefined : toPost(row);
}

async function findPostById(db: ContentDb, id: string): Promise<ContentPostRow | undefined> {
  const rows = await db
    .select()
    .from(contentPostsTable)
    .where(and(eq(contentPostsTable.id, id), notDeleted()))
    .limit(1);

  return rows[0];
}

/** Admin read by id, excluding soft-deleted rows. */
export async function getPostById(db: ContentDb, id: string): Promise<ContentPost | undefined> {
  const row = await findPostById(db, id);

  return row === undefined ? undefined : toPost(row);
}

/**
 * Whether `slug` is already taken within `type`. Deliberately does NOT skip
 * soft-deleted rows: they still occupy the `(type, slug)` unique index, so
 * reusing their slug would fail at the database level. Callers get a clean
 * 409 instead of a constraint error.
 */
export async function slugExists(
  db: ContentDb,
  type: ContentPostType,
  slug: string,
  excludePostId?: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: contentPostsTable.id })
    .from(contentPostsTable)
    .where(and(eq(contentPostsTable.type, type), eq(contentPostsTable.slug, slug)))
    .limit(2);

  return rows.some((row) => row.id !== excludePostId);
}

export interface CreatePostOptions {
  /**
   * Overrides the publication date. Store-level only, and used exclusively by
   * the seed script so migrated repository entries keep the date their
   * frontmatter declared instead of the date they were imported. No route
   * passes it, and `createPostBodySchema` does not accept it — for anything
   * arriving over HTTP, `publishedAt` stays server-owned.
   */
  publishedAt?: string;
}

export async function createPost(
  db: ContentDb,
  userId: string,
  input: CreatePostBody,
  options: CreatePostOptions = {},
): Promise<ContentPost> {
  const now = new Date().toISOString();
  const publishedAt =
    input.publicationState === "published"
      ? (options.publishedAt ?? now)
      : (options.publishedAt ?? null);

  const rows = await db
    .insert(contentPostsTable)
    .values({
      id: randomUUID(),
      type: input.type,
      slug: input.slug,
      title: input.title,
      summary: input.summary,
      description: input.description ?? null,
      body: input.body,
      publicationState: input.publicationState,
      publishedAt,
      featured: input.featured,
      projectStatus: input.projectStatus ?? null,
      repoUrl: input.repoUrl ?? null,
      liveUrl: input.liveUrl ?? null,
      createdBy: userId,
      updatedBy: userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const row = rows[0];

  if (row === undefined) {
    throw new Error("createPost: insert did not return a row.");
  }

  return toPost(row);
}

/**
 * Applies a partial update. Omitted fields keep their stored value; an
 * explicit `null` clears a nullable one. Returns `undefined` when the post
 * does not exist (or has been soft-deleted), so the route can answer 404.
 */
export async function updatePost(
  db: ContentDb,
  userId: string,
  input: UpdatePostBody,
): Promise<ContentPost | undefined> {
  const existing = await findPostById(db, input.id);

  if (existing === undefined) {
    return undefined;
  }

  const now = new Date().toISOString();
  const nextState = input.publicationState ?? existing.publicationState;

  const values: Partial<typeof contentPostsTable.$inferInsert> = {
    updatedBy: userId,
    updatedAt: now,
    publicationState: nextState,
    // First publish stamps the date; later state changes keep the original,
    // so unpublishing and republishing does not rewrite publication history.
    publishedAt: nextState === "published" ? (existing.publishedAt ?? now) : existing.publishedAt,
  };

  if (input.slug !== undefined) {
    values.slug = input.slug;
  }

  if (input.title !== undefined) {
    values.title = input.title;
  }

  if (input.summary !== undefined) {
    values.summary = input.summary;
  }

  if (input.description !== undefined) {
    values.description = input.description;
  }

  if (input.body !== undefined) {
    values.body = input.body;
  }

  if (input.featured !== undefined) {
    values.featured = input.featured;
  }

  if (input.projectStatus !== undefined) {
    values.projectStatus = input.projectStatus;
  }

  if (input.repoUrl !== undefined) {
    values.repoUrl = input.repoUrl;
  }

  if (input.liveUrl !== undefined) {
    values.liveUrl = input.liveUrl;
  }

  const rows = await db
    .update(contentPostsTable)
    .set(values)
    .where(eq(contentPostsTable.id, input.id))
    .returning();

  const row = rows[0];

  return row === undefined ? undefined : toPost(row);
}

export async function setPostsState(
  db: ContentDb,
  userId: string,
  ids: readonly string[],
  publicationState: ContentPost["publicationState"],
): Promise<number> {
  const now = new Date().toISOString();

  const rows = await db
    .update(contentPostsTable)
    .set({
      publicationState,
      updatedBy: userId,
      updatedAt: now,
      publishedAt:
        publicationState === "published"
          ? sql`COALESCE(${contentPostsTable.publishedAt}, ${now})`
          : contentPostsTable.publishedAt,
    })
    .where(and(inArray(contentPostsTable.id, [...ids]), notDeleted()))
    .returning({ id: contentPostsTable.id });

  return rows.length;
}

/**
 * Soft delete. Once content lives only in the database, a destructive click
 * has to stay recoverable — the row keeps its body and is filtered out of
 * every read path by `notDeleted()`.
 */
export async function deletePosts(
  db: ContentDb,
  userId: string,
  ids: readonly string[],
): Promise<number> {
  const now = new Date().toISOString();

  const rows = await db
    .update(contentPostsTable)
    .set({ deletedAt: now, updatedBy: userId, updatedAt: now })
    .where(and(inArray(contentPostsTable.id, [...ids]), notDeleted()))
    .returning({ id: contentPostsTable.id });

  return rows.length;
}

export interface StoredContentAsset extends ContentAssetMetadata {
  data: Buffer;
}

/**
 * Stores asset bytes under their content hash. Re-uploading identical bytes
 * is a no-op that returns the existing row, which is what makes the delivery
 * URL safe to cache immutably.
 */
export async function putAsset(
  db: ContentDb,
  userId: string,
  asset: {
    hash: string;
    contentType: string;
    size: number;
    data: Buffer;
    originalFilename: string;
  },
): Promise<ContentAssetMetadata> {
  const rows = await db
    .insert(contentAssetsTable)
    .values({
      hash: asset.hash,
      contentType: asset.contentType,
      size: asset.size,
      data: asset.data,
      originalFilename: asset.originalFilename,
      createdBy: userId,
    })
    .onConflictDoNothing({ target: contentAssetsTable.hash })
    .returning({
      hash: contentAssetsTable.hash,
      contentType: contentAssetsTable.contentType,
      size: contentAssetsTable.size,
      originalFilename: contentAssetsTable.originalFilename,
      createdAt: contentAssetsTable.createdAt,
    });

  const inserted = rows[0];

  if (inserted !== undefined) {
    return toAssetMetadata(inserted);
  }

  const existing = await getAssetMetadata(db, asset.hash);

  if (existing === undefined) {
    throw new Error("putAsset: conflicting row disappeared before it could be read back.");
  }

  return existing;
}

export async function getAssetMetadata(
  db: ContentDb,
  hash: string,
): Promise<ContentAssetMetadata | undefined> {
  const rows = await db
    .select({
      hash: contentAssetsTable.hash,
      contentType: contentAssetsTable.contentType,
      size: contentAssetsTable.size,
      originalFilename: contentAssetsTable.originalFilename,
      createdAt: contentAssetsTable.createdAt,
    })
    .from(contentAssetsTable)
    .where(eq(contentAssetsTable.hash, hash))
    .limit(1);

  const row = rows[0];

  return row === undefined ? undefined : toAssetMetadata(row);
}

export async function getAsset(
  db: ContentDb,
  hash: string,
): Promise<StoredContentAsset | undefined> {
  const rows = await db
    .select()
    .from(contentAssetsTable)
    .where(eq(contentAssetsTable.hash, hash))
    .limit(1);

  const row = rows[0];

  if (row === undefined) {
    return undefined;
  }

  return {
    ...toAssetMetadata(row),
    data: row.data,
  };
}

/** Metadata only — never selects the `data` blob column. */
export async function listAssets(db: ContentDb): Promise<ContentAssetMetadata[]> {
  const rows = await db
    .select({
      hash: contentAssetsTable.hash,
      contentType: contentAssetsTable.contentType,
      size: contentAssetsTable.size,
      originalFilename: contentAssetsTable.originalFilename,
      createdAt: contentAssetsTable.createdAt,
    })
    .from(contentAssetsTable)
    .orderBy(desc(contentAssetsTable.createdAt));

  return rows.map(toAssetMetadata);
}
