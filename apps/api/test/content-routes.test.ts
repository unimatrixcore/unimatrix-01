import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDatabase } from "@unimatrix/db";
import type { ContentPost, ListPostsResponse } from "@unimatrix/shared";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { LightMyRequestResponse } from "fastify";

import { buildApp } from "../src/app.js";
import { loadApiRuntimeConfig, type ApiRuntimeEnv } from "../src/config.js";
import type { ApiErrorEnvelope } from "../src/lib/http/errors.js";
import { createPost, putAsset, updatePost } from "../src/modules/content/store.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));

/**
 * Structurally valid Clerk credentials that belong to nobody, mirroring
 * `user-data-routes.test.ts`. `jwtKey` selects networkless verification and
 * every request here is unauthenticated, so nothing reaches the network.
 */
const DUMMY_CLERK_ENV: ApiRuntimeEnv = {
  CLERK_SECRET_KEY: "sk_test_dummy",
  CLERK_PUBLISHABLE_KEY: "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
  CLERK_JWT_KEY: "dummy-jwt-key",
};

type InjectableMethod = "DELETE" | "GET" | "HEAD" | "PATCH" | "POST" | "PUT";

interface RouteCase {
  method: InjectableMethod;
  url: string;
  payload?: Record<string, unknown>;
}

const VALID_POST_ID = "11111111-1111-4111-8111-111111111111";

/**
 * Every admin route, each carrying input its schema accepts — the
 * contract-driven routes validate before the auth preHandler runs, so invalid
 * input would answer 400 and the authorization assertions would pass for the
 * wrong reason.
 */
const ADMIN_ROUTES: readonly RouteCase[] = [
  { method: "GET", url: "/content/admin/posts" },
  { method: "GET", url: "/content/admin/post?type=blog&slug=first-post" },
  {
    method: "POST",
    url: "/content/admin/posts",
    payload: { type: "blog", slug: "new-post", title: "New", summary: "S", body: "B" },
  },
  { method: "PATCH", url: "/content/admin/posts", payload: { id: VALID_POST_ID, title: "New" } },
  {
    method: "POST",
    url: "/content/admin/posts/state",
    payload: { ids: [VALID_POST_ID], publicationState: "published" },
  },
  { method: "DELETE", url: "/content/admin/posts", payload: { ids: [VALID_POST_ID] } },
  { method: "GET", url: "/content/admin/assets" },
  { method: "POST", url: "/content/admin/assets" },
];

interface TestContext {
  app: ReturnType<typeof buildApp>;
  cleanup: () => void;
}

/**
 * Builds an app against a throwaway SQLite file. The API's database plugin
 * resolves its path from `DATABASE_URL`, so pointing that at a temp directory
 * keeps these tests off the repository's local database — CI never runs
 * migrations against that file, and a route test must not be the thing that
 * creates it.
 */
function createTestApp(options: { withClerk: boolean } = { withClerk: true }): TestContext {
  const directory = mkdtempSync(join(tmpdir(), "unimatrix-content-"));
  const filePath = join(directory, "content.sqlite");
  const previousDatabaseUrl = process.env.DATABASE_URL;

  const instance = createDatabase({ filePath });

  migrate(instance.db, { migrationsFolder: MIGRATIONS_FOLDER });
  instance.client.close();

  process.env.DATABASE_URL = filePath;

  const app = buildApp(
    loadApiRuntimeConfig({
      LOG_LEVEL: "error",
      NODE_ENV: "test",
      ...(options.withClerk ? DUMMY_CLERK_ENV : {}),
    }),
  );

  if (previousDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previousDatabaseUrl;
  }

  const context: TestContext = {
    app,
    cleanup: () => {
      rmSync(directory, { force: true, recursive: true });
    },
  };

  return context;
}

function inject(
  app: ReturnType<typeof buildApp>,
  route: RouteCase,
): Promise<LightMyRequestResponse> {
  return route.payload === undefined
    ? app.inject({ method: route.method, url: route.url })
    : app.inject({ method: route.method, url: route.url, payload: route.payload });
}

void test("published content is readable without authentication, drafts are not", async () => {
  const { app, cleanup } = createTestApp();

  try {
    await app.ready();

    const published = await createPost(app.db, "user_admin", {
      type: "blog",
      slug: "live-post",
      title: "Live post",
      summary: "Visible.",
      body: "# Live",
      publicationState: "published",
      featured: false,
    });

    await createPost(app.db, "user_admin", {
      type: "blog",
      slug: "draft-post",
      title: "Draft post",
      summary: "Hidden.",
      body: "# Draft",
      publicationState: "draft",
      featured: false,
    });

    const listResponse = await app.inject({ method: "GET", url: "/content/posts?type=blog" });

    assert.equal(listResponse.statusCode, 200);
    assert.deepEqual(
      listResponse.json<ListPostsResponse>().posts.map((post) => post.slug),
      ["live-post"],
    );

    const detailResponse = await app.inject({
      method: "GET",
      url: "/content/post?type=blog&slug=live-post",
    });

    assert.equal(detailResponse.statusCode, 200);
    assert.equal(detailResponse.json<ContentPost>().body, "# Live");
    assert.equal(detailResponse.json<ContentPost>().id, published.id);

    const draftResponse = await app.inject({
      method: "GET",
      url: "/content/post?type=blog&slug=draft-post",
    });

    assert.equal(draftResponse.statusCode, 404);
    assert.equal(draftResponse.json<ApiErrorEnvelope>().error.code, "NOT_FOUND");
  } finally {
    await app.close();
    cleanup();
  }
});

void test("public content responses carry an ETag that answers a conditional request with 304", async () => {
  const { app, cleanup } = createTestApp();

  try {
    await app.ready();

    await createPost(app.db, "user_admin", {
      type: "project",
      slug: "cflop",
      title: "CFLOP",
      summary: "A trainer.",
      body: "# Cube",
      publicationState: "published",
      featured: true,
    });

    for (const url of ["/content/posts?type=project", "/content/post?type=project&slug=cflop"]) {
      const first = await app.inject({ method: "GET", url });
      const etag = first.headers.etag;

      assert.equal(first.statusCode, 200, url);
      assert.equal(
        first.headers["cache-control"],
        "public, max-age=60, stale-while-revalidate=300",
        url,
      );
      assert.ok(typeof etag === "string" && etag.length > 0, `${url} should send an ETag`);

      const revalidated = await app.inject({
        method: "GET",
        url,
        headers: { "if-none-match": etag },
      });

      assert.equal(revalidated.statusCode, 304, `${url} should revalidate to 304`);
      assert.equal(revalidated.body, "", `${url} should send no body on 304`);
    }
  } finally {
    await app.close();
    cleanup();
  }
});

void test("an edit changes the ETag so a cached response is not reused", async () => {
  const { app, cleanup } = createTestApp();

  try {
    await app.ready();

    const post = await createPost(app.db, "user_admin", {
      type: "blog",
      slug: "changing-post",
      title: "Before",
      summary: "Before.",
      body: "# Before",
      publicationState: "published",
      featured: false,
    });

    const url = "/content/post?type=blog&slug=changing-post";
    const before = await app.inject({ method: "GET", url });

    await updatePost(app.db, "user_admin", { id: post.id, title: "After" });

    const after = await app.inject({
      method: "GET",
      url,
      headers: { "if-none-match": String(before.headers.etag) },
    });

    assert.equal(after.statusCode, 200, "a stale validator must not produce a 304");
    assert.equal(after.json<ContentPost>().title, "After");
  } finally {
    await app.close();
    cleanup();
  }
});

void test("assets are served inline, hash-addressed, and immutably cacheable", async () => {
  const { app, cleanup } = createTestApp();
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const hash = "e".repeat(64);

  try {
    await app.ready();

    await putAsset(app.db, "user_admin", {
      hash,
      contentType: "image/png",
      size: data.length,
      data,
      originalFilename: "diagram.png",
    });

    const response = await app.inject({ method: "GET", url: `/content/assets/${hash}` });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "image/png");
    assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["content-disposition"], `inline; filename="${hash}"`);
    assert.equal(response.headers["cross-origin-resource-policy"], "cross-origin");
    assert.ok(response.rawPayload.equals(data));

    const revalidated = await app.inject({
      method: "GET",
      url: `/content/assets/${hash}`,
      headers: { "if-none-match": `"${hash}"` },
    });

    assert.equal(revalidated.statusCode, 304);

    const missing = await app.inject({ method: "GET", url: `/content/assets/${"f".repeat(64)}` });

    assert.equal(missing.statusCode, 404);

    const malformed = await app.inject({ method: "GET", url: "/content/assets/not-a-hash" });

    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json<ApiErrorEnvelope>().error.code, "VALIDATION_ERROR");
  } finally {
    await app.close();
    cleanup();
  }
});

/**
 * The property this file exists for. Admin content routes create, edit, and
 * delete everything the public site shows; a route registered without
 * `requirePermission("auth", "admin")` would let any caller rewrite the site.
 * Unauthenticated requests must never reach a handler.
 */
void test("every admin content route rejects an unauthenticated request with 401", async () => {
  const { app, cleanup } = createTestApp();

  try {
    for (const route of ADMIN_ROUTES) {
      const label = `${route.method} ${route.url}`;
      const response = await inject(app, route);

      assert.equal(response.statusCode, 401, `${label} should reject with 401`);
      assert.deepEqual(response.json<ApiErrorEnvelope>().error, {
        code: "UNAUTHORIZED",
        message: "Authentication is required to access this resource.",
        statusCode: 401,
      });
    }

    // Fastify synthesises HEAD from each GET and shares its preHandler chain.
    // Asserted rather than assumed: a HEAD that bypassed the guard would
    // confirm a draft's existence through the status code alone.
    for (const url of ["/content/admin/posts", "/content/admin/assets"]) {
      const response = await app.inject({ method: "HEAD", url });

      assert.equal(response.statusCode, 401, `HEAD ${url} should reject with 401`);
    }
  } finally {
    await app.close();
    cleanup();
  }
});

void test("admin content routes are absent when Clerk is not configured", async () => {
  const { app, cleanup } = createTestApp({ withClerk: false });

  try {
    assert.equal(app.runtimeConfig.clerk, null);

    for (const route of ADMIN_ROUTES) {
      const response = await inject(app, route);

      assert.equal(
        response.statusCode,
        404,
        `${route.method} ${route.url} should be absent, not open`,
      );
    }

    // The public read routes stay registered either way: the public site has
    // to render its blog and project pages with no Clerk configured at all.
    const listResponse = await app.inject({ method: "GET", url: "/content/posts?type=blog" });

    assert.equal(listResponse.statusCode, 200);
    assert.deepEqual(listResponse.json<ListPostsResponse>(), { posts: [] });
  } finally {
    await app.close();
    cleanup();
  }
});

/**
 * Guards `ADMIN_ROUTES` against drift. Fastify's own route tree is the source
 * of truth: an admin route added to the module but not listed above would be
 * silently exempt from the 401 assertions.
 */
void test("the admin route list covers every /content/admin route the module registers", async () => {
  const { app, cleanup } = createTestApp();

  try {
    await app.ready();

    const registered = new Set<string>();
    // `printRoutes` renders a tree whose child lines carry only their own path
    // segment, so the full URL has to be rebuilt from its ancestors. Depth is
    // the number of four-character indent units before the branch marker.
    const segments: string[] = [];

    for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
      const match = /^(?<indent>[\s│]*)[├└]── (?<segment>\S+) \((?<methods>[A-Z, ]+)\)/u.exec(line);

      if (match?.groups === undefined) {
        continue;
      }

      const { indent, segment, methods } = match.groups;

      if (indent === undefined || segment === undefined || methods === undefined) {
        continue;
      }

      const depth = Math.floor(indent.length / 4);

      segments.length = depth;
      segments[depth] = segment;

      const url = segments.join("").replace(/\/$/u, "");

      if (!url.startsWith("/content/admin")) {
        continue;
      }

      for (const method of methods.split(", ")) {
        // Fastify synthesises a HEAD for every GET; those share the GET's
        // preHandler chain and are covered by the GET entry.
        if (method !== "HEAD") {
          registered.add(`${method} ${url}`);
        }
      }
    }

    const listed = new Set(
      ADMIN_ROUTES.map((route) => `${route.method} ${route.url.split("?")[0]}`),
    );

    assert.ok(registered.size > 0, "expected printRoutes to report /content/admin routes");
    assert.deepEqual(
      [...registered].filter((route) => !listed.has(route)).sort(),
      [],
      "every registered /content/admin route must appear in ADMIN_ROUTES",
    );
    assert.deepEqual(
      [...listed].filter((route) => !registered.has(route)).sort(),
      [],
      "every route in ADMIN_ROUTES must actually be registered",
    );
  } finally {
    await app.close();
    cleanup();
  }
});

/** Strips line and block comments so commented-out code cannot satisfy a check. */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/^[ \t]*\/\/.*$/gmu, "");
}

/**
 * One chunk per route declaration, covering both forms the modules use: the
 * `.route({ ... })` object and the `.post(url, opts, handler)` shorthand. The
 * shorthand is not cosmetic — CodeQL's per-route rate-limit rule only sees a
 * ceiling declared that way — so a structural check that knew only about the
 * object form would silently stop counting the route that carries one.
 */
function splitRouteDefinitions(source: string): string[] {
  return stripComments(source)
    .split(/\.route\(\{|\.(?:get|post|put|patch|delete)\(\s*"/u)
    .slice(1);
}

/**
 * The structural counterpart to the 401 test above, and the reason both exist.
 *
 * A real Clerk session cannot be minted in this suite, so no behavioural test
 * here can prove that an *authenticated non-admin* is refused — the 401 tests
 * only prove that an anonymous caller is. Dropping
 * `preHandler: requireAdmin` from an admin route would leave every assertion
 * in this file green while opening publish and delete to any signed-in user.
 * This pins the guard itself.
 *
 * The three public routes are named explicitly rather than inferred, so adding
 * a fourth unguarded route fails here instead of quietly joining the public
 * surface.
 */
void test("every admin content route declares requireAdmin, and only the public routes do not", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../src/modules/content/index.ts", import.meta.url)),
    "utf8",
  );
  const definitions = splitRouteDefinitions(source);
  const publicUrls = [
    "url: listPostsContract.path",
    "url: getPostContract.path",
    'url: "/content/assets/:hash"',
  ];

  assert.equal(
    definitions.length,
    ADMIN_ROUTES.length + publicUrls.length,
    "expected one route declaration per admin route plus the three public ones",
  );

  const unguarded = definitions.filter(
    (definition) => !definition.includes("preHandler: requireAdmin,"),
  );

  assert.equal(unguarded.length, publicUrls.length);

  for (const [index, publicUrl] of publicUrls.entries()) {
    assert.ok(
      unguarded[index]?.includes(publicUrl),
      `unguarded route #${index + 1} in src/modules/content/index.ts should be ${publicUrl}`,
    );
  }
});

/**
 * Self-check for the check: if `stripComments` ever stopped working, a
 * commented-out guard would satisfy the structural test above.
 */
void test("stripComments hides commented-out guards from the structural check", () => {
  const commented =
    'app.route({\n  method: "GET",\n  // preHandler: requireAdmin,\n  handler: noop,\n});';
  const [commentedDefinition, ...rest] = splitRouteDefinitions(commented);

  assert.equal(rest.length, 0);
  assert.ok(commentedDefinition !== undefined);
  assert.ok(!commentedDefinition.includes("preHandler: requireAdmin,"));

  const real = 'app.route({\n  method: "GET",\n  preHandler: requireAdmin,\n  handler: noop,\n});';
  const [realDefinition] = splitRouteDefinitions(real);

  assert.ok(realDefinition?.includes("preHandler: requireAdmin,"));
});

void test("public content routes reject unknown collections and malformed slugs", async () => {
  const { app, cleanup } = createTestApp();

  try {
    const badType = await app.inject({ method: "GET", url: "/content/posts?type=docs" });

    assert.equal(badType.statusCode, 400);
    assert.equal(badType.json<ApiErrorEnvelope>().error.code, "VALIDATION_ERROR");

    const badSlug = await app.inject({
      method: "GET",
      url: "/content/post?type=blog&slug=Not%20A%20Slug",
    });

    assert.equal(badSlug.statusCode, 400);
    assert.equal(badSlug.json<ApiErrorEnvelope>().error.code, "VALIDATION_ERROR");
  } finally {
    await app.close();
    cleanup();
  }
});

void test("public cursor boundary bounds pages and validates continuation input", async () => {
  const { app, cleanup } = createTestApp({ withClerk: false });
  try {
    await app.ready();
    for (let index = 0; index < 3; index++) {
      await createPost(app.db, "user_admin", {
        type: "project",
        slug: `paged-${index}`,
        title: `Paged ${index}`,
        summary: "Summary",
        body: "Body",
        publicationState: "published",
        featured: index !== 0,
      });
    }
    const first = await app.inject({
      method: "GET",
      url: "/content/posts?type=project&featured=true&limit=1",
    });
    assert.equal(first.statusCode, 200);
    const body = first.json<ListPostsResponse>();
    assert.equal(body.posts.length, 1);
    assert.equal(body.posts[0]?.featured, true);
    assert.ok(body.nextCursor);
    const second = await app.inject({
      method: "GET",
      url: `/content/posts?type=project&featured=true&limit=1&cursor=${encodeURIComponent(body.nextCursor)}`,
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json<ListPostsResponse>().nextCursor, null);
    assert.notEqual(second.json<ListPostsResponse>().posts[0]?.id, body.posts[0]?.id);
    for (const query of [
      "limit=0",
      "limit=201",
      "limit=1.5",
      "cursor=broken",
      "cursor=%5B1%2C2%5D",
    ]) {
      const invalid = await app.inject({
        method: "GET",
        url: `/content/posts?type=project&${query}`,
      });
      assert.equal(invalid.statusCode, 400, query);
    }
  } finally {
    await app.close();
    cleanup();
  }
});
