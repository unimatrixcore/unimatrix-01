import { describe, expect, it } from "vitest";

import {
  createPostBodySchema,
  updatePostBodySchema,
  listPostsQuerySchema,
  adminListPostsQuerySchema,
} from "../src/index.js";

const POST_ID = "3f8a1c2e-5b7d-4e91-a0c3-6d2f8b4e1a97";

const BASE_POST = {
  type: "project",
  slug: "cflop",
  title: "CFLOP",
  summary: "A trainer.",
  body: "# CFLOP",
} as const;

function parseWithLiveUrl(liveUrl: string): boolean {
  return createPostBodySchema.safeParse({ ...BASE_POST, liveUrl }).success;
}

describe("urlSchema scheme restriction", () => {
  it("accepts http and https URLs", () => {
    expect(parseWithLiveUrl("https://cflop.unimatrix-01.dev")).toBe(true);
    expect(parseWithLiveUrl("http://localhost:5173")).toBe(true);
  });

  it("rejects javascript: URLs", () => {
    expect(parseWithLiveUrl("javascript:alert(1)")).toBe(false);
    // Scheme matching is case-insensitive in the URL parser, so a mixed-case
    // spelling must not slip past.
    expect(parseWithLiveUrl("jAvAsCrIpT:alert(1)")).toBe(false);
  });

  it("rejects data: URLs", () => {
    expect(parseWithLiveUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("rejects other schemes that z.url() alone would accept", () => {
    expect(parseWithLiveUrl("ftp://example.dev/x")).toBe(false);
    expect(parseWithLiveUrl("mailto:someone@example.dev")).toBe(false);
  });

  it("still rejects strings that are not URLs at all", () => {
    expect(parseWithLiveUrl("not a url")).toBe(false);
    expect(parseWithLiveUrl("/relative/path")).toBe(false);
  });

  it("applies the same restriction to repoUrl and to updates", () => {
    expect(createPostBodySchema.safeParse({ ...BASE_POST, repoUrl: "javascript:0" }).success).toBe(
      false,
    );
    expect(updatePostBodySchema.safeParse({ id: POST_ID, repoUrl: "javascript:0" }).success).toBe(
      false,
    );
    expect(
      updatePostBodySchema.safeParse({ id: POST_ID, repoUrl: "https://example.dev" }).success,
    ).toBe(true);
  });

  it("still allows clearing a URL with null", () => {
    expect(createPostBodySchema.safeParse({ ...BASE_POST, liveUrl: null }).success).toBe(true);
  });
});

describe("content paging boundary", () => {
  it("accepts serialized stable cursors and coerces HTTP page sizes", () => {
    const cursor = JSON.stringify(["2026-11-01T00:00:00.000Z", POST_ID]);
    expect(
      listPostsQuerySchema.parse({ type: "project", featured: "true", limit: "50", cursor }),
    ).toEqual({ type: "project", featured: "true", limit: 50, cursor });
    expect(adminListPostsQuerySchema.parse({ limit: "1", cursor }).limit).toBe(1);
  });

  it("rejects malformed cursors and unbounded page sizes before querying storage", () => {
    for (const cursor of [
      "broken",
      "null",
      "{}",
      "[1,2]",
      JSON.stringify(["time", ""]),
      JSON.stringify(["time", "x".repeat(129)]),
      "x".repeat(513),
    ]) {
      expect(listPostsQuerySchema.safeParse({ type: "blog", cursor }).success).toBe(false);
    }
    for (const limit of [0, -1, 201, 1.5, "bad"]) {
      expect(listPostsQuerySchema.safeParse({ type: "blog", limit }).success).toBe(false);
      expect(adminListPostsQuerySchema.safeParse({ limit }).success).toBe(false);
    }
  });
});
