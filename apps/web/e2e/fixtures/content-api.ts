import type { Page, Route } from "@playwright/test";

/**
 * Blog and project content is served by the API, and the Playwright run
 * starts `vite preview` with no API behind it. Every content request is
 * therefore fulfilled here.
 *
 * Stable authored fixtures keep the smoke assertions independent of the
 * live content database and its publication state.
 *
 * App-local by rule: `@unimatrix/e2e-helpers` is app-agnostic, and this knows
 * exactly what apps/web publishes.
 */
const BLOG_POST = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "blog",
  slug: "placeholder-post",
  title: "Placeholder blog",
  summary: "This is explicitly a placeholder blog post. A real post will replace it later.",
  description: null,
  publicationState: "published",
  publishedAt: "2026-03-17",
  featured: false,
  projectStatus: null,
  repoUrl: null,
  liveUrl: null,
  updatedAt: "2026-03-17T00:00:00.000Z",
  body: [
    "This is a placeholder blog post while I figure out what belongs here.",
    "",
    "A full write-up will replace it once the piece is complete and ready to share.",
    "",
    "For now, this page is intentionally brief and intentionally a placeholder.",
  ].join("\n"),
} as const;

const PROJECT_POST = {
  id: "22222222-2222-4222-8222-222222222222",
  type: "project",
  slug: "cflop",
  title: "CFLOP",
  summary: "A flashcard trainer for memorizing every 3x3 Rubik's Cube OLL and PLL algorithm.",
  description: null,
  publicationState: "published",
  publishedAt: "2026-07-22",
  featured: true,
  projectStatus: "active",
  repoUrl: null,
  liveUrl: "https://cflop.unimatrix-01.dev",
  updatedAt: "2026-07-22T00:00:00.000Z",
  body: [
    "CFLOP is a browser-based drill tool for the last-layer stage of the CFOP speedcubing method: 57 OLL cases for orienting the last layer, and 21 PLL cases for permuting it into place.",
    "",
    "Both modes track per-case progress in the browser, so learning and training pool selections persist between sessions without an account.",
  ].join("\n"),
} as const;

type ContentPostFixture = typeof BLOG_POST | typeof PROJECT_POST;

const POSTS: readonly ContentPostFixture[] = [BLOG_POST, PROJECT_POST];

function toSummary(post: ContentPostFixture): Omit<ContentPostFixture, "body"> {
  // List responses carry summaries only, so the fixture has to drop `body` the
  // same way the API does. Destructuring it out trips `no-unused-vars` (this
  // config sets no ignore pattern) and the fixtures are `as const`, so `delete`
  // is a readonly-property error.
  return Object.fromEntries(Object.entries(post).filter(([key]) => key !== "body")) as Omit<
    ContentPostFixture,
    "body"
  >;
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * Intercepts every content request the public site makes. Call before the
 * first navigation in a test.
 */
export async function stubContentApi(page: Page): Promise<void> {
  await page.route("**/api/content/posts?*", async (route) => {
    const type = new URL(route.request().url()).searchParams.get("type");

    await fulfillJson(route, 200, {
      posts: POSTS.filter((post) => post.type === type).map(toSummary),
    });
  });

  await page.route("**/api/content/post?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const post = POSTS.find(
      (candidate) => candidate.type === params.get("type") && candidate.slug === params.get("slug"),
    );

    if (post === undefined) {
      await fulfillJson(route, 404, {
        error: { code: "NOT_FOUND", message: "No published entry found.", statusCode: 404 },
        requestId: "e2e",
      });

      return;
    }

    await fulfillJson(route, 200, post);
  });
}
