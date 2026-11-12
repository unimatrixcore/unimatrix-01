import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDatabase, contentPostsTable, type DatabaseInstance } from "@unimatrix/db";
import type { CreatePostBody } from "@unimatrix/shared";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import {
  createPost,
  deletePosts,
  getAsset,
  getPostById,
  getPostForAdmin,
  getPublishedPost,
  listAssets,
  listContentPage,
  listPostsForAdmin,
  listPublishedPosts,
  putAsset,
  setPostsState,
  slugExists,
  updatePost,
} from "../src/modules/content/store.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));

const ADMIN_USER_ID = "user_admin";

function createMigratedInMemoryDatabase(): DatabaseInstance {
  const instance = createDatabase({ filePath: ":memory:" });

  migrate(instance.db, { migrationsFolder: MIGRATIONS_FOLDER });

  return instance;
}

function buildCreateBody(overrides: Partial<CreatePostBody> = {}): CreatePostBody {
  return {
    type: "blog",
    slug: "first-post",
    title: "First post",
    summary: "A summary.",
    body: "# Body",
    publicationState: "draft",
    featured: false,
    ...overrides,
  };
}

void test("createPost stamps publishedAt only once a post is published", async () => {
  const { client, db } = createMigratedInMemoryDatabase();

  try {
    const draft = await createPost(db, ADMIN_USER_ID, buildCreateBody());

    assert.equal(draft.publicationState, "draft");
    assert.equal(draft.publishedAt, null);

    const published = await createPost(
      db,
      ADMIN_USER_ID,
      buildCreateBody({ slug: "second-post", publicationState: "published" }),
    );

    assert.equal(published.publicationState, "published");
    assert.notEqual(published.publishedAt, null);
  } finally {
    client.close();
  }
});

void test("public reads expose published posts only", async () => {
  const { client, db } = createMigratedInMemoryDatabase();

  try {
    await createPost(db, ADMIN_USER_ID, buildCreateBody({ slug: "draft-post" }));
    const published = await createPost(
      db,
      ADMIN_USER_ID,
      buildCreateBody({ slug: "live-post", publicationState: "published" }),
    );

    const posts = await listPublishedPosts(db, "blog");

    assert.deepEqual(
      posts.map((post) => post.slug),
      ["live-post"],
    );

    assert.equal(await getPublishedPost(db, "blog", "draft-post"), undefined);
    assert.equal((await getPublishedPost(db, "blog", "live-post"))?.id, published.id);

    // Admin reads see both, which is the difference this pair of paths exists
    // to enforce.
    assert.equal((await getPostForAdmin(db, "blog", "draft-post"))?.slug, "draft-post");
    assert.equal((await listPostsForAdmin(db, {})).length, 2);
  } finally {
    client.close();
  }
});

void test("listPublishedPosts orders newest first and filters by collection", async () => {
  const { client, db } = createMigratedInMemoryDatabase();

  try {
    await createPost(
      db,
      ADMIN_USER_ID,
      buildCreateBody({ slug: "older", publicationState: "published" }),
    );

    // `publishedAt` is stamped from the wall clock at millisecond precision,
    // so two posts created back-to-back can tie and make the assertion below
    // depend on how fast the machine is. One millisecond apart is enough.
    await new Promise((resolve) => setTimeout(resolve, 2));

    await createPost(
      db,
      ADMIN_USER_ID,
      buildCreateBody({ slug: "newer", publicationState: "published" }),
    );
    await createPost(
      db,
      ADMIN_USER_ID,
      buildCreateBody({ type: "project", slug: "a-project", publicationState: "published" }),
    );

    const blogPosts = await listPublishedPosts(db, "blog");

    assert.deepEqual(
      blogPosts.map((post) => post.slug),
      ["newer", "older"],
    );

    const projectPosts = await listPublishedPosts(db, "project");

    assert.deepEqual(
      projectPosts.map((post) => post.slug),
      ["a-project"],
    );
  } finally {
    client.close();
  }
});

void test("updatePost applies partial changes and preserves the first publication date", async () => {
  const { client, db } = createMigratedInMemoryDatabase();

  try {
    const post = await createPost(
      db,
      ADMIN_USER_ID,
      buildCreateBody({ publicationState: "published", description: "Original description." }),
    );
    const firstPublishedAt = post.publishedAt;

    const titleOnly = await updatePost(db, "user_editor", {
      id: post.id,
      title: "Renamed",
    });

    assert.equal(titleOnly?.title, "Renamed");
    assert.equal(titleOnly?.body, "# Body", "omitted fields keep their stored value");
    assert.equal(titleOnly?.description, "Original description.");

    const cleared = await updatePost(db, "user_editor", { id: post.id, description: null });

    assert.equal(cleared?.description, null, "an explicit null clears a nullable field");

    await updatePost(db, "user_editor", { id: post.id, publicationState: "draft" });
    const republished = await updatePost(db, "user_editor", {
      id: post.id,
      publicationState: "published",
    });

    assert.equal(
      republished?.publishedAt,
      firstPublishedAt,
      "republishing must not rewrite publication history",
    );
  } finally {
    client.close();
  }
});

void test("updatePost reports a missing or soft-deleted post as undefined", async () => {
  const { client, db } = createMigratedInMemoryDatabase();

  try {
    const post = await createPost(db, ADMIN_USER_ID, buildCreateBody());

    await deletePosts(db, ADMIN_USER_ID, [post.id]);

    assert.equal(await updatePost(db, ADMIN_USER_ID, { id: post.id, title: "Nope" }), undefined);
    assert.equal(await getPostById(db, post.id), undefined);
  } finally {
    client.close();
  }
});

void test("slugExists guards new posts, ignores the post being edited, and counts soft-deleted rows", async () => {
  const { client, db } = createMigratedInMemoryDatabase();

  try {
    const post = await createPost(db, ADMIN_USER_ID, buildCreateBody());

    assert.equal(await slugExists(db, "blog", "first-post"), true);
    assert.equal(await slugExists(db, "project", "first-post"), false, "slugs are per collection");
    assert.equal(
      await slugExists(db, "blog", "first-post", post.id),
      false,
      "a post does not conflict with itself",
    );

    await deletePosts(db, ADMIN_USER_ID, [post.id]);

    assert.equal(
      await slugExists(db, "blog", "first-post"),
      true,
      "a soft-deleted row still occupies the unique index",
    );
  } finally {
    client.close();
  }
});

void test("bulk operations report how many rows they touched", async () => {
  const { client, db } = createMigratedInMemoryDatabase();

  try {
    const first = await createPost(db, ADMIN_USER_ID, buildCreateBody({ slug: "one" }));
    const second = await createPost(db, ADMIN_USER_ID, buildCreateBody({ slug: "two" }));
    const missingId = "00000000-0000-4000-8000-000000000000";

    assert.equal(
      await setPostsState(db, ADMIN_USER_ID, [first.id, second.id, missingId], "published"),
      2,
    );

    const published = await listPublishedPosts(db, "blog");

    assert.equal(published.length, 2);
    assert.ok(published.every((post) => post.publishedAt !== null));

    assert.equal(await deletePosts(db, ADMIN_USER_ID, [first.id, missingId]), 1);
    assert.equal(
      await deletePosts(db, ADMIN_USER_ID, [first.id]),
      0,
      "a soft-deleted row cannot be deleted twice",
    );
    assert.equal((await listPublishedPosts(db, "blog")).length, 1);
  } finally {
    client.close();
  }
});

void test("putAsset is content-addressed and idempotent", async () => {
  const { client, db } = createMigratedInMemoryDatabase();
  const data = Buffer.from("fake-png-bytes");
  const hash = "c".repeat(64);

  try {
    const first = await putAsset(db, ADMIN_USER_ID, {
      hash,
      contentType: "image/png",
      size: data.length,
      data,
      originalFilename: "diagram.png",
    });

    const second = await putAsset(db, ADMIN_USER_ID, {
      hash,
      contentType: "image/png",
      size: data.length,
      data,
      originalFilename: "diagram-copy.png",
    });

    assert.deepEqual(second, first, "re-uploading identical bytes returns the existing row");
    assert.equal((await listAssets(db)).length, 1);

    const stored = await getAsset(db, hash);

    assert.ok(stored?.data.equals(data));
    assert.equal(await getAsset(db, "d".repeat(64)), undefined);
  } finally {
    client.close();
  }
});

void test("cursor pages cover timestamp ties once and survive cursor-row deletion", async () => {
  const { client, db } = createMigratedInMemoryDatabase();
  try {
    const saved = [];
    for (let i = 0; i < 7; i++) {
      saved.push(
        await createPost(
          db,
          ADMIN_USER_ID,
          buildCreateBody({ slug: `page-${i}`, publicationState: "published" }),
        ),
      );
    }
    await createPost(db, ADMIN_USER_ID, buildCreateBody({ slug: "hidden-draft" }));
    await db
      .update(contentPostsTable)
      .set({ publishedAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" });
    const first = await listContentPage(db, { type: "blog", limit: 2 }, "public");
    assert.equal(first.posts.length, 2);
    assert.ok(first.nextCursor);
    const ids = first.posts.map((post) => post.id);
    await deletePosts(db, ADMIN_USER_ID, [first.posts[1]!.id]);
    let cursor: string | null | undefined = first.nextCursor;
    while (cursor) {
      const page = await listContentPage(db, { type: "blog", limit: 2, cursor }, "public");
      ids.push(...page.posts.map((post) => post.id));
      cursor = page.nextCursor;
    }
    assert.equal(new Set(ids).size, 7);
    assert.deepEqual([...ids].sort(), saved.map((post) => post.id).sort());
    const admin = await listContentPage(db, { publicationState: "draft", limit: 2 }, "admin");
    assert.equal(admin.posts.length, 1);
    assert.equal(admin.posts[0]?.slug, "hidden-draft");
    assert.equal(admin.nextCursor, null);
    const featured = await listContentPage(
      db,
      { type: "project", featured: "true", limit: 2 },
      "public",
    );
    assert.deepEqual(featured, { posts: [], nextCursor: null });
  } finally {
    client.close();
  }
});
